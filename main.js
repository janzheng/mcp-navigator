import { Hono } from 'https://deno.land/x/hono@v3.11.12/mod.ts';
import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown

// Backend module imports
import { groqResponses } from './backend/groq.js';
import { toolsRegistry, resolveToolConfig } from './backend/tools.js';
import { generateConfigFromServer, lookupFromMcpRegistry } from './backend/registry.js';
import { 
  discoverMcpTools, 
  handleToolExecution, 
  handleToolListing, 
  aiToolSelection 
} from './backend/handlers.js';

const app = new Hono();

// Note: toolsRegistry is now imported from ./backend/tools.js
// Keeping this comment to show the registry structure has been moved

// Generic API endpoint that wraps Groq Responses
app.post('/api/groq/responses', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { model, input, tools = [] } = body;

    // Get API key from various sources
    const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const headerKey = m ? m[1].trim() : '';
    const apiKey = headerKey || body?.apiKey || Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ error: 'No Groq API key available.' }, 400);
    }

    if (!model || !input) {
      return c.json({ error: 'model and input are required' }, 400);
    }

    const result = await groqResponses(apiKey, model, input, tools);
    return c.json(result);
  } catch (error) {
    console.error('Groq responses endpoint error:', error);
    return c.json({ error: 'Groq responses error: ' + error.message }, 500);
  }
});

// Debug endpoint to check environment variables and tool configs
app.get('/api/debug', (c) => {
  const hasGroqKey = !!Deno.env.get("GROQ_API_KEY");
  const hasParallelKey = !!Deno.env.get("PARALLEL_API_KEY");
  
  return c.json({
    environment: {
      GROQ_API_KEY: hasGroqKey ? "✓ Available" : "✗ Missing",
      PARALLEL_API_KEY: hasParallelKey ? "✓ Available" : "✗ Missing"
    },
    toolsRegistry: Object.fromEntries(
      Object.entries(toolsRegistry).map(([name, config]) => [
        name, 
        {
          ...config,
          headers: config.headers ? Object.keys(config.headers) : []
        }
      ])
    ),
    resolvedTools: Object.fromEntries(
      Object.entries(toolsRegistry).map(([name, config]) => [
        name,
        resolveToolConfig(config)
      ])
    )
  });
});

// Dynamic tool endpoint - uses any tool from the registry by name (POST)
app.post('/api/tool/:toolName', async (c) => {
  try {
    const toolName = c.req.param('toolName');
    const body = await c.req.json().catch(() => ({}));
    const { model = "openai/gpt-oss-120b", input, toolHeaders = {} } = body;

    // Get API key
    const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const headerKey = m ? m[1].trim() : '';
    const apiKey = headerKey || body?.apiKey || Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ error: 'No Groq API key available.' }, 400);
    }

    if (!input) {
      return c.json({ error: 'input is required' }, 400);
    }

    // Use the refactored execution function with per-tool headers
    const userToolHeaders = { [toolName]: toolHeaders };
    console.log(`API tool endpoint: executing '${toolName}' with input '${input}'`);
    
    // Check if tool exists locally first, for logging purposes
    const isInLocalRegistry = toolsRegistry.hasOwnProperty(toolName);
    console.log(`Tool '${toolName}' ${isInLocalRegistry ? 'found in local registry' : 'will be searched in MCP registry'}`);
    
    const result = await handleToolExecution(toolName, input, model, apiKey, userToolHeaders);
    
    if (result.error) {
      return c.json(result.response, result.status);
    }
    
    return c.json(result.response);
  } catch (error) {
    console.error(`Tool endpoint error for '${c.req.param('toolName')}':`, error);
    return c.json({ error: 'Tool endpoint error: ' + error.message }, 500);
  }
});

// Registry endpoint - browse and discover MCP servers
app.get('/api/registry', async (c) => {
  try {
    const search = c.req.query('search') || '';
    const limit = parseInt(c.req.query('limit') || '50');
    const cursor = c.req.query('cursor') || '';

    // Build registry API URL
    const registryUrl = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    if (limit) registryUrl.searchParams.set('limit', limit.toString());
    if (cursor) registryUrl.searchParams.set('cursor', cursor);

    // Fetch from MCP registry
    const response = await fetch(registryUrl.toString());
    if (!response.ok) {
      throw new Error(`Registry API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Filter by search term if provided and only include servers with remotes
    let servers = data.servers || [];
    
    // Only include servers with remotes (can be run through Groq)
    servers = servers.filter(server => server.remotes && server.remotes.length > 0);
    
    if (search) {
      const searchLower = search.toLowerCase();
      servers = servers.filter(server =>
        server.name?.toLowerCase().includes(searchLower) ||
        server.description?.toLowerCase().includes(searchLower)
      );
    }

    // Add side-load instructions for each server
    const serversWithInstructions = servers.map(server => ({
      ...server,
      sideload: {
        instructions: "To side-load this server, add it to your toolsRegistry in main.js",
        suggestedConfig: generateConfigFromServer(server),
        testUrl: `/api/tools?tools=${server.name.replace(/[^a-zA-Z0-9_]/g, '_')}&q=test`
      }
    }));

    return c.json({
      servers: serversWithInstructions,
      metadata: data.metadata,
      search,
      totalFound: serversWithInstructions.length,
      note: "Only shows MCP servers with 'remotes' that can be run through Groq",
      examples: {
        search: "/api/registry?search=gmail",
        withLimit: "/api/registry?limit=10",
        nextPage: data.metadata?.next_cursor ? `/api/registry?cursor=${data.metadata.next_cursor}` : null
      }
    });
  } catch (error) {
    console.error('Registry endpoint error:', error);
    return c.json({
      error: 'Registry fetch error: ' + error.message,
      registryUrl: 'https://registry.modelcontextprotocol.io/v0/servers'
    }, 500);
  }
});

// Tools endpoint - handles both documentation AND tool execution (GET)
app.get('/api/tools', async (c) => {
  try {
    const toolsParam = c.req.query('tools'); // Can be comma-separated list
    const query = c.req.query('q');
    const mode = c.req.query('mode') || 'execute'; // 'execute' or 'list'
    const model = c.req.query('model') || "openai/gpt-oss-120b";

    // If no query parameters, show API documentation
    if (!toolsParam && !query && !c.req.query('mode')) {
      // Generate tool-specific examples dynamically from toolsRegistry
      const toolExamples = {};
      
      for (const [toolName, toolConfig] of Object.entries(toolsRegistry)) {
        // Use metadata if available, otherwise generate based on tool configuration
        let description = "MCP tool";
        let exampleQuery = "search or perform operations";
        let useCases = ["General operations"];

        // First, check if we have explicit metadata
        if (toolConfig._meta) {
          description = toolConfig._meta.description || description;
          exampleQuery = toolConfig._meta.example_queries?.[0] || exampleQuery;
          useCases = toolConfig._meta.use_cases || useCases;
        } else if (toolConfig._registry?.description) {
          // Use registry description if available from dynamic lookup
          description = toolConfig._registry.description;
          exampleQuery = `perform operations with ${toolName}`;
          useCases = ["Various operations"];
        } else {
          // Fallback to smart detection based on tool name and server_label
          const serverLabel = toolConfig.server_label?.toLowerCase() || toolName.toLowerCase();
          
          if (serverLabel.includes('search') || serverLabel.includes('web')) {
            description = "Web search with AI-optimized results";
            exampleQuery = "what's the weather in San Francisco";
            useCases = ["Current events", "Research", "Weather", "News"];
          } else if (serverLabel.includes('github')) {
            description = "GitHub repository management and operations";
            exampleQuery = "create an issue in my repo about adding MCP examples";
            useCases = ["Create issues", "Manage repos", "Code search", "Pull requests"];
          } else if (serverLabel.includes('huggingface') || serverLabel.includes('hf')) {
            description = "Hugging Face model discovery and information";
            exampleQuery = "what are the trending AI models this week?";
            useCases = ["Model discovery", "Trending models", "Model info", "AI research"];
          } else if (serverLabel.includes('gmail') || serverLabel.includes('email')) {
            description = "Email management and operations";
            exampleQuery = "search for emails about the project from last week";
            useCases = ["Email search", "Send emails", "Manage inbox", "Email drafts"];
          } else if (serverLabel.includes('code') || serverLabel.includes('programming')) {
            description = "Code analysis and programming assistance";
            exampleQuery = "analyze this code for potential improvements";
            useCases = ["Code review", "Debugging", "Documentation", "Refactoring"];
          } else if (serverLabel.includes('file') || serverLabel.includes('filesystem')) {
            description = "File system operations and management";
            exampleQuery = "find all Python files modified in the last week";
            useCases = ["File search", "File operations", "Directory management", "File analysis"];
          }
        }

        toolExamples[toolName] = {
          description,
          example: `/api/tools?tools=${toolName}&q=${encodeURIComponent(exampleQuery)}`,
          use_cases: useCases
        };
      }

      return c.json({ 
        message: "Groq MCP Navigation API",
        endpoints: {
          "/api/groq/responses": "Generic Groq Responses API wrapper (POST)",
          "/api/tool/:toolName": "Dynamic tool endpoint using registry (POST)",
          "/api/tools": "Unified tools endpoint - GET with query params, POST with per-tool API keys",
          "/api/select": "AI-powered tool selection and execution (GET/POST)",
          "/api/registry": "Browse and discover MCP servers from official registry",
          "/api/debug": "Debug endpoint to check environment and tool configurations"
        },
        availableTools: Object.keys(toolsRegistry),
        toolExamples,
        quickStart: {
          listAllTools: "/api/tools?mode=list",
          browseRegistry: "/api/registry",
          searchRegistry: "/api/registry?search=gmail",
          mcpRegistryExample: "/api/tools?tools=garden.stanislav.svelte-llm/svelte-llm-mcp&q=what are svelte runes"
        },
        aiSelection: {
          executeGet: '/api/select?q=Plan a trip to Tokyo',
          curlGet: '/api/select?q=Find trending AI models&mode=curl',
          executePost: 'POST /api/select with { "query": "Plan a trip to Tokyo", "mode": "execute" }',
          curlPost: 'POST /api/select with { "query": "Find trending AI models", "mode": "curl" }',
          description: "AI automatically selects the best tools for your query"
        },
        multiToolExample: (() => {
          const availableTools = Object.keys(toolsRegistry);
          const toolSubset = availableTools.slice(0, 3); // Take first 3 tools
          return {
            url: `/api/tools?tools=${toolSubset.join(',')}&q=${encodeURIComponent('coordinate multiple systems to research and summarize findings')}`,
            description: `Coordinate across multiple systems: ${toolSubset.join(', ')}`,
            note: "Demonstrates using multiple MCP tools in a single request"
          };
        })(),
        parameters: {
          "tools": "Comma-separated list of tool names",
          "q": "Query/input for the tools",
          "mode": "Either 'execute' (default) or 'list'",
          "model": "Optional model override (default: openai/gpt-oss-120b)"
        }
      });
    }

    // Get API key from environment (for browser testing, we'll use server key)
    const apiKey = Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ 
        error: 'No Groq API key available. Set GROQ_API_KEY environment variable.',
        note: 'This endpoint uses the server API key for easy browser testing.'
      }, 400);
    }

    // Handle list mode
    if (mode === 'list') {
      const result = await handleToolListing(toolsParam, model, apiKey);
      if (result.error) {
        return c.json(result.response, result.status);
      }
      return c.json(result.response);
    }

    // Handle execute mode
    if (mode === 'execute') {
      const result = await handleToolExecution(toolsParam, query, model, apiKey);
      if (result.error) {
        return c.json(result.response, result.status);
      }
      return c.json(result.response);
    }

    // Invalid mode
    return c.json({
      error: `Invalid mode '${mode}'. Use 'execute' or 'list'`,
      examples: {
        list: "/api/tools?mode=list",
        execute: "/api/tools?tools=parallel_web_search&q=what's the weather in SF"
      }
    }, 400);

  } catch (error) {
    console.error(`Root endpoint error:`, error);
    
    // Return appropriate status code based on error type
    if (error.message.includes('Authentication failed') || error.message.includes('401')) {
      return c.json({ 
        error: 'Authentication Error: ' + error.message,
        statusCode: 401 
      }, 401);
    }
    
    return c.json({ 
      error: 'Root endpoint error: ' + error.message,
      statusCode: 500 
    }, 500);
  }
});

// Tools endpoint - handles tool execution with per-tool API keys (POST)
app.post('/api/tools', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { 
      tools: toolsParam, 
      q: query, 
      mode = 'execute', 
      model = "openai/gpt-oss-120b",
      toolHeaders = {} // Per-tool API keys: { "toolName": { "x-api-key": "key123" } }
    } = body;

    // Get Groq API key from header, body, or environment
    const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const headerKey = m ? m[1].trim() : '';
    const apiKey = headerKey || body?.apiKey || Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ 
        error: 'No Groq API key available. Provide via Authorization header, body.apiKey, or GROQ_API_KEY env var.',
        examples: {
          authHeader: 'Authorization: Bearer YOUR_GROQ_API_KEY',
          bodyKey: '{ "apiKey": "YOUR_GROQ_API_KEY", "tools": "...", "q": "..." }',
          envVar: 'Set GROQ_API_KEY environment variable'
        }
      }, 400);
    }

    // Handle list mode
    if (mode === 'list') {
      const result = await handleToolListing(toolsParam, model, apiKey, toolHeaders);
      if (result.error) {
        return c.json(result.response, result.status);
      }
      return c.json(result.response);
    }

    // Handle execute mode
    if (mode === 'execute') {
      const result = await handleToolExecution(toolsParam, query, model, apiKey, toolHeaders);
      if (result.error) {
        return c.json(result.response, result.status);
      }
      return c.json(result.response);
    }

    // Invalid mode
    return c.json({
      error: `Invalid mode '${mode}'. Use 'execute' or 'list'`,
      examples: {
        list: { mode: 'list', tools: 'parallel_web_search' },
        execute: { mode: 'execute', tools: 'parallel_web_search', q: "what's the weather in SF" }
      }
    }, 400);

  } catch (error) {
    console.error(`Root POST endpoint error:`, error);
    
    // Return appropriate status code based on error type
    if (error.message.includes('Authentication failed') || error.message.includes('401')) {
      return c.json({ 
        error: 'Authentication Error: ' + error.message,
        statusCode: 401 
      }, 401);
    }
    
    return c.json({ 
      error: 'Root POST endpoint error: ' + error.message,
      statusCode: 500 
    }, 500);
  }
});

// AI-powered tool selection and execution endpoint (POST)
app.post('/api/select', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { 
      query, 
      mode = 'execute', // 'execute' or 'curl'
      model = "openai/gpt-oss-120b",
      conversation_history = []
    } = body;

    // Get Groq API key
    const authHeader = c.req.header('Authorization') || c.req.header('authorization') || '';
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    const headerKey = m ? m[1].trim() : '';
    const apiKey = headerKey || body?.apiKey || Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ 
        error: 'No Groq API key available. Provide via Authorization header, body.apiKey, or GROQ_API_KEY env var.'
      }, 400);
    }

    if (!query) {
      return c.json({ 
        error: 'Query parameter is required',
        example: {
          query: "Build a travel itinerary for Tokyo",
          mode: "execute"
        }
      }, 400);
    }

    const result = await aiToolSelection(query, mode, apiKey, model, conversation_history);
    return c.json(result);
    
  } catch (error) {
    console.error(`AI selection endpoint error:`, error);
    return c.json({ 
      error: 'AI selection error: ' + error.message,
      statusCode: 500 
    }, 500);
  }
});

// AI-powered tool selection and execution endpoint (GET)
app.get('/api/select', async (c) => {
  try {
    const query = c.req.query('q') || c.req.query('query');
    const mode = c.req.query('mode') || 'execute'; // 'execute' or 'curl'
    const model = c.req.query('model') || "openai/gpt-oss-120b";

    // Get API key from environment (for browser testing)
    const apiKey = Deno.env.get("GROQ_API_KEY");

    if (!apiKey) {
      return c.json({ 
        error: 'No Groq API key available. Set GROQ_API_KEY environment variable.',
        note: 'This GET endpoint uses the server API key for easy browser testing.'
      }, 400);
    }

    if (!query) {
      return c.json({ 
        error: 'Query parameter "q" or "query" is required',
        examples: {
          execute: '/api/select?q=Plan a trip to Tokyo',
          curl: '/api/select?q=Find trending AI models&mode=curl',
          withModel: '/api/select?q=Weather in NYC&mode=execute&model=openai/gpt-oss-120b'
        }
      }, 400);
    }

    const result = await aiToolSelection(query, mode, apiKey, model, []);
    return c.json(result);
    
  } catch (error) {
    console.error(`AI selection GET endpoint error:`, error);
    return c.json({ 
      error: 'AI selection error: ' + error.message,
      statusCode: 500 
    }, 500);
  }
});

// Helper function to read file content
async function readFileContent(filePath) {
  try {
    const content = await Deno.readTextFile(filePath);
    return content;
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error.message}`);
  }
}

// Root endpoint - serve the app interface
app.get('/', async (c) => {
  try {
    const htmlContent = await readFileContent('index.html');
    return c.html(htmlContent);
  } catch (error) {
    console.error('Error reading HTML file:', error);
    return c.text('Error loading page', 500);
  }
});

// Serve frontend modules (no static middleware)
app.get('/frontend/init.js', async (c) => {
  try {
    const js = await readFileContent('frontend/init.js');
    return new Response(js, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache' },
    });
  } catch (error) {
    console.error('Error reading init.js:', error);
    return c.text('Not found', 404);
  }
});

app.get('/frontend/mcpNavApp.js', async (c) => {
  try {
    const js = await readFileContent('frontend/mcpNavApp.js');
    return new Response(js, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache' },
    });
  } catch (error) {
    console.error('Error reading mcpNavApp.js:', error);
    return c.text('Not found', 404);
  }
});

export default (typeof Deno !== "undefined" && Deno.env.get("valtown")) ? app.fetch : app;