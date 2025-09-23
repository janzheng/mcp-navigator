import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown
import { groqResponses } from './groq.js';
import { toolsRegistry, resolveToolConfig, toolSchemaCache } from './tools.js';
import { lookupFromMcpRegistry } from './registry.js';
import { llmRouter, generateCurlCommand } from './ai.js';

// Configuration for handling different types of MCP servers
const MCP_SERVER_CONFIG = {
  // Default configuration for any MCP server
  default: {
    commonEndpoints: ['/mcp', '/sse'],
    defaultHeaders: {},
    requireApproval: 'never'
  },
  
  // Override patterns can be added here if needed
  // Example: 'example.com': { specialHandling: true }
};

// Helper to get cached tool schema for a specific tool
function getCachedToolSchema(toolName, serverUrl) {
  const cacheKey = `${toolName}_${serverUrl}`;
  const cachedTools = toolSchemaCache.get(cacheKey);
  if (cachedTools && Array.isArray(cachedTools)) {
    return cachedTools.find(tool => tool.name === toolName);
  }
  return null;
}

// Helper to get server configuration
function getMcpServerConfig(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    
    // Check for specific hostname configurations
    for (const [pattern, config] of Object.entries(MCP_SERVER_CONFIG)) {
      if (pattern !== 'default' && hostname.includes(pattern)) {
        return { ...MCP_SERVER_CONFIG.default, ...config };
      }
    }
    
    return MCP_SERVER_CONFIG.default;
  } catch {
    return MCP_SERVER_CONFIG.default;
  }
}

// Function to dynamically discover actual tools from an MCP server
export async function discoverMcpTools(toolName, toolConfig, apiKey, model) {
  const cacheKey = `${toolName}_${toolConfig.server_url}`;
  
  // Check cache first
  if (toolSchemaCache.has(cacheKey)) {
    return toolSchemaCache.get(cacheKey);
  }
  
  try {
    console.log(`Discovering tools for ${toolName}...`);
    
    // Resolve tool configuration
    const resolvedTool = resolveToolConfig(toolConfig, {});
    
    // Make a test call to discover available tools
    const result = await groqResponses(apiKey, model, "List available tools", [resolvedTool]);
    
    // Extract the actual tools from the response
    const toolsList = result?.output?.find(item => item.type === 'mcp_list_tools');
    
    let discoveredTools = [];
    if (toolsList && toolsList.tools) {
      discoveredTools = toolsList.tools.map(tool => ({
        name: tool.name,
        description: tool.description || `${tool.name} function`,
        inputSchema: tool.inputSchema || { type: "object", properties: {} }
      }));
      console.log(`Discovered ${discoveredTools.length} tools for ${toolName}:`, discoveredTools.map(t => t.name));
    } else {
      console.log(`No tools discovered for ${toolName}, will use fallback`);
    }
    
    // Cache the result
    toolSchemaCache.set(cacheKey, discoveredTools);
    return discoveredTools;
    
  } catch (error) {
    console.warn(`Failed to discover tools for ${toolName}:`, error.message);
    // Cache empty array to avoid repeated failed attempts
    toolSchemaCache.set(cacheKey, []);
    return [];
  }
}

// Function to detect and create config from URL
function createConfigFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const serverConfig = getMcpServerConfig(url);
    
    return {
      type: "mcp",
      server_label: `Custom MCP Server (${urlObj.hostname})`,
      server_url: url,
      headers: serverConfig.defaultHeaders,
      require_approval: serverConfig.requireApproval,
      _meta: {
        description: `Custom MCP server at ${urlObj.hostname}`,
        source: 'dynamic_url',
        config: serverConfig
      }
    };
  } catch (error) {
    console.warn('Invalid URL provided:', url);
    return null;
  }
}

// Function to detect if a tool parameter is a URL
function isUrlTool(toolParam) {
  try {
    const url = new URL(toolParam);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Core function to handle tool lookup and execution
export async function handleToolExecution(toolsParam, query, model, apiKey, userToolHeaders = {}, conversationHistory = []) {
  if (!toolsParam) {
  return {
      error: true, 
      status: 400,
      response: { 
        error: 'tools parameter is required',
        example: "/api/tools?tools=parallel_web_search&q=what's the weather in San Francisco",
        availableTools: Object.keys(toolsRegistry)
      }
    };
  }

  if (!query) {
    return { 
      error: true, 
      status: 400,
      response: { 
        error: 'Query parameter "q" is required for execute mode',
        example: "/api/tools?tools=parallel_web_search&q=what's the weather in San Francisco",
        availableTools: Object.keys(toolsRegistry)
      }
    };
  }

  // Parse tools (can be comma-separated)
  const toolNames = toolsParam.split(',').map(t => t.trim());
  const tools = [];

  // Extract discovered servers from conversation history
  const discoveredServers = extractDiscoveredServers(conversationHistory);
  
  for (const toolName of toolNames) {
    let toolConfig = toolsRegistry[toolName];
    let isFromMcpRegistry = false;
    let isFromUrl = false;
    let isFromConversation = false;
    
    // Check if toolName is a URL
    if (isUrlTool(toolName)) {
      toolConfig = createConfigFromUrl(toolName);
      if (toolConfig) {
        isFromUrl = true;
        console.log(`Created dynamic tool config from URL: ${toolName}`);
      }
    }
    
    // If not found locally and not a URL, check conversation history for discovered servers
    if (!toolConfig) {
      const serverUrl = findServerForTool(toolName, discoveredServers);
      if (serverUrl) {
        toolConfig = createConfigFromUrl(serverUrl);
        if (toolConfig) {
          isFromConversation = true;
          console.log(`Using tool '${toolName}' from conversation-discovered server: ${serverUrl}`);
        }
      }
    }
    
    if (!toolConfig) {
      // Try to find and load from MCP registry
      try {
        toolConfig = await lookupFromMcpRegistry(toolName);
        if (toolConfig) {
          isFromMcpRegistry = true;
          console.log(`Dynamically loaded tool '${toolName}' from MCP registry for execution`);
        }
      } catch (error) {
        console.warn(`Failed to lookup '${toolName}' in MCP registry:`, error.message);
      }
    }
    
    if (!toolConfig) {
      return { 
        error: true, 
        status: 404,
        response: { 
          error: `Tool '${toolName}' not found in local registry, MCP registry, or is not a valid URL`,
          availableTools: Object.keys(toolsRegistry),
          suggestion: `Try searching the registry: /api/registry?search=${encodeURIComponent(toolName)}, or provide a valid MCP server URL`
        }
      };
    }

    // Get user-provided headers for this specific tool
    // Try multiple potential header mappings
    let toolHeaders = userToolHeaders[toolName] || {};
    
    // If no direct match, try variations of the tool name
    if (Object.keys(toolHeaders).length === 0) {
      const possibleKeys = [
        toolName.toLowerCase(),
        toolName.replace(/[^a-zA-Z0-9]/g, '_'),
        toolName.split('/').pop(), // For registry names like "ai.waystation/gmail"
        toolName.split('.').pop(), // For domain-like names
      ];
      
      for (const key of possibleKeys) {
        if (userToolHeaders[key]) {
          toolHeaders = userToolHeaders[key];
          console.log(`Mapped tool '${toolName}' to headers from key '${key}'`);
          break;
        }
      }
    }

    // Resolve tool configuration with user headers
    const resolvedTool = resolveToolConfig(toolConfig, toolHeaders);
    console.log(`Resolved tool config for ${toolName}:`, JSON.stringify(resolvedTool, null, 2));

    // Check if tool has missing API keys - but continue with warning instead of failing
    const missingKeys = [];
    if (resolvedTool.headers) {
      for (const [key, value] of Object.entries(resolvedTool.headers)) {
        if (typeof value === 'string' && (value === 'Bearer undefined' || value === 'undefined' || !value.trim())) {
          missingKeys.push(key);
        }
      }
    }
    
    // Add warning for missing keys but don't block execution
    if (missingKeys.length > 0) {
      console.warn(`Tool '${toolName}' has missing API keys: ${missingKeys.join(', ')}`);
    }

    tools.push(resolvedTool);
  }

  try {
    // For simple tool calls, check if we have cached schema information
    let modifiedQuery = query;
    if (toolNames.length === 1 && (query.toLowerCase().includes('run ') || query.toLowerCase().includes('execute '))) {
      const toolName = toolNames[0];
      
      // Check if we have cached schema for this tool
      const serverUrl = tools[0]?.server_url;
      if (serverUrl) {
        const toolSchema = getCachedToolSchema(toolName, serverUrl);
        if (toolSchema) {
          const params = toolSchema.inputSchema?.properties || {};
          const paramNames = Object.keys(params);
          console.log(`Found cached schema for ${toolName}:`, paramNames.length ? paramNames : 'no parameters');
          
          if (paramNames.length === 0) {
            // Tool takes no parameters
            modifiedQuery = `Use the ${toolName} tool without any parameters`;
          } else {
            // Tool has parameters - be more explicit about what we want
            modifiedQuery = `Use the ${toolName} tool${paramNames.includes('topic') ? '' : ' without specifying a topic'}`;
          }
        } else {
          // No cached schema - use conservative approach
          modifiedQuery = `Use the ${toolName} tool with default settings`;
        }
        console.log(`Modified query for tool execution: ${modifiedQuery}`);
      }
    }
    
    const result = await groqResponses(apiKey, model, modifiedQuery, tools);
    return { error: false, response: result };
  } catch (error) {
    console.error('Tool execution error:', error);
    
    // If it's a schema validation error, try with a simpler approach
    if (error.message.includes('did not match schema') && toolNames.length === 1) {
      console.log('Attempting retry with simplified parameters...');
      try {
        const simpleQuery = `Use the ${toolNames[0]} tool`;
        const result = await groqResponses(apiKey, model, simpleQuery, tools);
        return { error: false, response: result };
      } catch (retryError) {
        console.error('Retry also failed:', retryError.message);
        // Continue with original error handling below
      }
    }
    
    // Enhanced error handling for MCP server issues
    if ((error.message.includes('500') || error.message.includes('400')) && tools.some(tool => tool.type === 'mcp')) {
      const mcpServerUrls = tools.filter(tool => tool.type === 'mcp').map(tool => tool.server_url);
      
      return {
        error: true,
        status: 500,
        response: {
          error: error.message.includes('400') ? 'MCP Tool Schema Validation Failed' : 'MCP Server Execution Failed',
          details: error.message,
          mcp_servers: mcpServerUrls,
          suggestion: error.message.includes('400') 
            ? 'The MCP tool was found but there\'s a parameter schema mismatch. This usually means the tool expects different parameters than what was provided.'
            : 'This appears to be an issue with Groq\'s Remote MCP API when executing tools from this server. The server discovery worked, but execution failed.',
          troubleshooting: error.message.includes('400') ? [
            'Tool schema validation failed - the tool parameters don\'t match the expected schema',
            'This could be due to incomplete schema information during tool discovery',
            'Try using the tool with explicit parameters if you know the expected format',
            'The MCP server may need to provide more detailed schema information'
          ] : [
            'The MCP server is accessible and tools were discovered successfully',
            'This may be a temporary issue with Groq\'s Remote MCP implementation',
            'Try again in a few moments',
            'Use the generated curl command to test the API directly',
            'Consider trying a different MCP server if the issue persists'
          ]
        }
      };
    }
    
    return { 
      error: true, 
      status: error.message.includes('401') ? 401 : 500,
      response: error.message 
    };
  }
}

// Core function to handle tool listing
export async function handleToolListing(toolsParam, model, apiKey, userToolHeaders = {}, conversationHistory = []) {
  if (!toolsParam) {
    // Return all available tools from registry
    return {
      error: false,
      response: {
        availableTools: Object.keys(toolsRegistry),
        examples: {
          listAll: "/api/tools?mode=list",
          listSpecific: "/api/tools?tools=parallel_web_search&mode=list",
          execute: "/api/tools?tools=parallel_web_search&q=what's the weather in SF"
        }
      }
    };
  }

  // Get schema for specific tools
  const toolNames = toolsParam.split(',').map(t => t.trim());
  const toolSchemas = [];

  // Extract discovered servers from conversation history
  const discoveredServers = extractDiscoveredServers(conversationHistory);
  
  for (const toolName of toolNames) {
    let toolConfig = toolsRegistry[toolName];
    let isFromMcpRegistry = false;
    let isFromUrl = false;
    let isFromConversation = false;
    
    // Check if toolName is a URL
    if (isUrlTool(toolName)) {
      toolConfig = createConfigFromUrl(toolName);
      if (toolConfig) {
        isFromUrl = true;
        console.log(`Created dynamic tool config from URL for listing: ${toolName}`);
      }
    }
    
    // If not found locally and not a URL, check conversation history
    if (!toolConfig) {
      const serverUrl = findServerForTool(toolName, discoveredServers);
      if (serverUrl) {
        toolConfig = createConfigFromUrl(serverUrl);
        if (toolConfig) {
          isFromConversation = true;
          console.log(`Using tool '${toolName}' from conversation-discovered server for listing: ${serverUrl}`);
        }
      }
    }
    
    if (!toolConfig) {
      // Try to find and load from MCP registry
      try {
        toolConfig = await lookupFromMcpRegistry(toolName);
        if (toolConfig) {
          isFromMcpRegistry = true;
          console.log(`Dynamically loaded tool '${toolName}' from MCP registry for listing`);
        }
      } catch (error) {
        console.warn(`Failed to lookup '${toolName}' in MCP registry:`, error.message);
      }
    }
    
    if (!toolConfig) {
      return { 
        error: true, 
        status: 404,
        response: { 
          error: `Tool '${toolName}' not found in local registry, MCP registry, or is not a valid URL`,
          availableTools: Object.keys(toolsRegistry),
          suggestion: `Try searching the registry: /api/registry?search=${encodeURIComponent(toolName)}, or provide a valid MCP server URL`
        }
      };
    }

    try {
      // Get user-provided headers for this specific tool
      // Try multiple potential header mappings
      let toolHeaders = userToolHeaders[toolName] || {};
      
      // If no direct match, try variations of the tool name
      if (Object.keys(toolHeaders).length === 0) {
        const possibleKeys = [
          toolName.toLowerCase(),
          toolName.replace(/[^a-zA-Z0-9]/g, '_'),
          toolName.split('/').pop(), // For registry names like "ai.waystation/gmail"
          toolName.split('.').pop(), // For domain-like names
        ];
        
        for (const key of possibleKeys) {
          if (userToolHeaders[key]) {
            toolHeaders = userToolHeaders[key];
            console.log(`Mapped tool '${toolName}' to headers from key '${key}' (listing)`);
            break;
          }
        }
      }

      // Resolve tool configuration with user headers
      const resolvedTool = resolveToolConfig(toolConfig, toolHeaders);
      
      // Check if tool has missing API keys
      const missingKeys = [];
      if (resolvedTool.headers) {
        for (const [key, value] of Object.entries(resolvedTool.headers)) {
          if (typeof value === 'string' && (value === 'Bearer undefined' || value === 'undefined' || !value.trim())) {
            missingKeys.push(key);
          }
        }
      }
      
      if (missingKeys.length > 0) {
        toolSchemas.push({
          toolName,
          server_label: toolConfig.server_label,
          status: "inaccessible",
          reason: `Missing API keys: ${missingKeys.join(', ')}`,
          tools: [],
          tool_count: 0,
          source: isFromUrl ? 'dynamic_url' : (isFromMcpRegistry ? 'mcp_registry' : 'local_registry'),
          ...(isFromMcpRegistry && toolConfig._registry ? { registry_info: toolConfig._registry } : {})
        });
        continue;
      }
      
      // Make a simple request to Groq to get tool list (this will trigger mcp_list_tools)
      const result = await groqResponses(apiKey, model, "List available tools", [resolvedTool]);
      
      // Debug: Log the full response to understand the structure
      console.log(`Tool listing response for ${toolName}:`, JSON.stringify(result, null, 2));
      
    // Extract tool list from the response or use hardcoded actual tools
    const toolsList = result?.output?.find(item => item.type === 'mcp_list_tools');
    
    if (toolsList) {
      // Store the complete tool schemas for later use
      if (toolsList.tools && toolsList.tools.length > 0) {
        const cacheKey = `${toolName}_${toolConfig.server_url}`;
        toolSchemaCache.set(cacheKey, toolsList.tools);
        console.log(`Cached tool schemas for ${toolName}:`, toolsList.tools.map(t => `${t.name} (${Object.keys(t.inputSchema?.properties || {}).join(', ') || 'no params'})`));
      }
      
      toolSchemas.push({
        toolName,
        server_label: toolsList.server_label,
        tools: toolsList.tools,
        tool_count: toolsList.tools?.length || 0,
        source: isFromUrl ? 'dynamic_url' : (isFromMcpRegistry ? 'mcp_registry' : 'local_registry'),
        ...(isFromMcpRegistry && toolConfig._registry ? { registry_info: toolConfig._registry } : {})
      });
    }
    } catch (error) {
      // Handle 401/424 errors gracefully
      if (error.message.includes('401') || error.message.includes('424') || error.message.includes('Authentication failed')) {
        toolSchemas.push({
          toolName,
          server_label: toolConfig.server_label,
          status: "inaccessible",
          reason: "Authentication failed - check API keys",
          tools: [],
          tool_count: 0,
          source: isFromUrl ? 'dynamic_url' : (isFromMcpRegistry ? 'mcp_registry' : 'local_registry'),
          ...(isFromMcpRegistry && toolConfig._registry ? { registry_info: toolConfig._registry } : {})
        });
      } else {
        toolSchemas.push({
          toolName,
          server_label: toolConfig.server_label,
          status: "error",
          reason: `Failed to get schema: ${error.message}`,
          tools: [],
          tool_count: 0,
          source: isFromUrl ? 'dynamic_url' : (isFromMcpRegistry ? 'mcp_registry' : 'local_registry'),
          ...(isFromMcpRegistry && toolConfig._registry ? { registry_info: toolConfig._registry } : {})
        });
      }
    }
  }

  return {
    error: false,
    response: {
      mode: 'list',
      schemas: toolSchemas
    }
  };
}

// Execute selected tools
export async function executeSelectedTools(selectedTools, apiKey, model, toolHeaders = {}, conversationHistory = []) {
  const toolNames = selectedTools.selected_tools?.map(t => t.name) || [];
  const query = selectedTools.execution_query || 'Execute selected tools';
  
  if (toolNames.length === 0) {
    return {
      error: 'No tools selected by AI',
      selected_tools: selectedTools
    };
  }

  // Extract discovered servers from conversation history
  const discoveredServers = extractDiscoveredServers(conversationHistory);
  
  // Build the actual tool configurations for the curl example
  const tools = [];
  for (const selected of selectedTools.selected_tools || []) {
    let toolConfig;
    
    if (selected.registry === 'local') {
      toolConfig = toolsRegistry[selected.name];
      if (toolConfig) {
        // Resolve the actual tool config for Groq
        const resolvedConfig = resolveToolConfig(toolConfig, {});
        tools.push(resolvedConfig);
      }
    } else if (selected.registry === 'discovered') {
      // Tool discovered from conversation history
      const serverUrl = findServerForTool(selected.name, discoveredServers);
      if (serverUrl) {
        toolConfig = createConfigFromUrl(serverUrl);
        if (toolConfig) {
          const resolvedConfig = resolveToolConfig(toolConfig, {});
          tools.push(resolvedConfig);
          console.log(`Using discovered tool '${selected.name}' from ${serverUrl}`);
        }
      }
    } else {
      // Public registry tool
      try {
        const dynamicConfig = await lookupFromMcpRegistry(selected.name);
        if (dynamicConfig) {
          const resolvedConfig = resolveToolConfig(dynamicConfig, {});
          tools.push(resolvedConfig);
        }
      } catch (error) {
        console.warn(`Failed to lookup ${selected.name}:`, error.message);
      }
    }
  }

  // Use existing handleToolExecution function with conversation history
  const result = await handleToolExecution(toolNames.join(','), query, model, apiKey, toolHeaders, conversationHistory);
  
  return {
    mode: 'execute',
    selected_tools: selectedTools.selected_tools,
    execution_query: selectedTools.execution_query,
    tool_names: toolNames,
    tools_config: tools, // Include actual tool configurations
    result: result.error ? result.response : result.response,
    error: result.error ? result.response : null, // Pass error info to frontend
    used_tool_headers: Object.keys(toolHeaders).length > 0 ? Object.keys(toolHeaders) : null
  };
}

// Function to extract discovered MCP servers from conversation history
function extractDiscoveredServers(conversationHistory) {
  const discoveredServers = new Map();
  
  // Look through conversation history for introspection responses that discovered tools
  conversationHistory.forEach(message => {
    if (message.type === 'assistant' && message.content) {
      // Look for patterns indicating server discovery
      const serverUrlMatch = message.content.match(/Available tools at (https?:\/\/[^\s]+)/i);
      if (serverUrlMatch) {
        const serverUrl = serverUrlMatch[1];
        
        // Extract tool names from the message
        const toolMatches = message.content.match(/- \*\*([^*]+)\*\*:/g);
        if (toolMatches) {
          const tools = toolMatches.map(match => {
            const toolName = match.match(/- \*\*([^*]+)\*\*/)[1];
            return toolName;
          });
          
          discoveredServers.set(serverUrl, {
            url: serverUrl,
            tools: tools,
            discoveredAt: message.timestamp
          });
          
          console.log(`Extracted discovered server from conversation: ${serverUrl} with tools: ${tools.join(', ')}`);
        }
      }
    }
  });
  
  return discoveredServers;
}

// Function to find which server provides a specific tool from conversation history
function findServerForTool(toolName, discoveredServers) {
  for (const [serverUrl, serverInfo] of discoveredServers) {
    if (serverInfo.tools.includes(toolName)) {
      console.log(`Found tool '${toolName}' on server: ${serverUrl}`);
      return serverUrl;
    }
  }
  return null;
}

// Function to extract API keys from user messages
function extractApiKeysFromMessage(userQuery) {
  const extractedKeys = {};
  
  // Patterns to match API keys in user messages
  const patterns = [
    // "use api key sk-xxx for github"
    /(?:use|with)\s+(?:api\s*key|key)\s+([a-zA-Z0-9_\-]+)\s+for\s+([a-zA-Z0-9._\/-]+)/gi,
    // "github api key: sk-xxx" 
    /([a-zA-Z0-9._\/-]+)\s+(?:api\s*key|key):\s*([a-zA-Z0-9_\-]+)/gi,
    // "api key sk-xxx for gmail"
    /(?:api\s*key|key)\s+([a-zA-Z0-9_\-]+)\s+for\s+([a-zA-Z0-9._\/-]+)/gi,
    // Generic bearer token patterns
    /(?:bearer|token):\s*([a-zA-Z0-9_\-\.]+)/gi,
    // Authorization header patterns
    /authorization:\s*bearer\s+([a-zA-Z0-9_\-\.]+)/gi
  ];
  
  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(userQuery)) !== null) {
      if (match.length >= 3) {
        // Format: tool -> key
        const tool = match[2].toLowerCase();
        const key = match[1];
        extractedKeys[tool] = { "Authorization": `Bearer ${key}` };
      } else if (match.length >= 2) {
        // Generic key
        const key = match[1];
        extractedKeys["default"] = { "Authorization": `Bearer ${key}` };
      }
    }
  });
  
  return extractedKeys;
}

// AI-powered tool selection function
export async function aiToolSelection(userQuery, mode, apiKey, model, conversationHistory = [], toolHeaders = {}) {
  try {
    // Extract API keys from user message
    const extractedKeys = extractApiKeysFromMessage(userQuery);
    
    // Check if user provided a custom MCP server URL
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const urlMatches = userQuery.match(urlPattern);
    let customUrls = [];
    
    if (urlMatches) {
      customUrls = urlMatches.filter(url => {
        // Filter for URLs that look like MCP server endpoints
        return url.includes('/sse') || url.includes('/mcp') || url.includes('api');
      });
      console.log('Detected custom MCP URLs:', customUrls);
    }
    
    // If we have a custom URL and it looks like a direct tool query, handle it specially
    if (customUrls.length > 0 && (userQuery.toLowerCase().includes('check') || userQuery.toLowerCase().includes('available') || userQuery.toLowerCase().includes('list'))) {
      // Directly execute the tool listing for the custom URL
      const customUrl = customUrls[0];
      console.log(`Direct tool listing for custom URL: ${customUrl}`);
      
      try {
        const result = await handleToolListing(customUrl, model, apiKey, toolHeaders, conversationHistory);
        
        if (!result.error && result.response.schemas?.length > 0) {
          const schema = result.response.schemas[0];
          
          let responseText = `## Available tools at ${customUrl}\n\n`;
          
          if (schema.tools && schema.tools.length > 0) {
            responseText += `**Server:** ${schema.server_label}\n`;
            responseText += `**Total tools:** ${schema.tool_count}\n\n`;
            responseText += `**Available tools:**\n`;
            schema.tools.forEach(tool => {
              responseText += `- **${tool.name}**: ${tool.description || 'No description available'}\n`;
            });
          } else if (schema.status === 'inaccessible') {
            responseText += `❌ **Server is inaccessible**: ${schema.reason}\n\n`;
            responseText += `This may be due to missing API keys or authentication requirements.`;
          } else {
            responseText += `⚠️ **No tools found** at this MCP server.`;
          }
          
          return {
            introspection: true,
            response: responseText,
            custom_url: customUrl,
            discovered_tools: schema.tools || [],
            tool_count: schema.tool_count || 0
          };
        } else {
          return {
            error: true,
            response: `Failed to connect to MCP server at ${customUrl}: ${result.response?.error || 'Unknown error'}`,
            custom_url: customUrl
          };
        }
      } catch (error) {
        return {
          error: true,
          response: `Error checking MCP server at ${customUrl}: ${error.message}`,
          custom_url: customUrl
        };
      }
    }
    
    // Merge extracted keys with provided toolHeaders (user provided takes precedence)
    const mergedToolHeaders = { ...extractedKeys, ...toolHeaders };
    
    // Clean the user query by removing API key information for processing
    let cleanedQuery = userQuery;
    const apiKeyPatterns = [
      /(?:use|with)\s+(?:api\s*key|key)\s+[a-zA-Z0-9_\-]+\s+for\s+[a-zA-Z0-9._\/-]+/gi,
      /[a-zA-Z0-9._\/-]+\s+(?:api\s*key|key):\s*[a-zA-Z0-9_\-]+/gi,
      /(?:api\s*key|key)\s+[a-zA-Z0-9_\-]+\s+for\s+[a-zA-Z0-9._\/-]+/gi,
      /(?:bearer|token):\s*[a-zA-Z0-9_\-\.]+/gi,
      /authorization:\s*bearer\s+[a-zA-Z0-9_\-\.]+/gi
    ];
    
    apiKeyPatterns.forEach(pattern => {
      cleanedQuery = cleanedQuery.replace(pattern, '').trim();
    });
    
    if (Object.keys(extractedKeys).length > 0) {
      console.log(`Extracted API keys for tools:`, Object.keys(extractedKeys));
    }
    // Get local registry context - use hardcoded schemas for known tools to avoid unnecessary API calls
    const localRegistry = [];
    for (const toolName of Object.keys(toolsRegistry)) {
      const tool = toolsRegistry[toolName];
      
      // Use hardcoded tool info for known tools instead of making API discovery calls
      let availableFunctions = [];
      let functionCount = 0;
      
      // Add hardcoded schemas for known tools to avoid API discovery
      if (toolName === 'huggingface') {
        availableFunctions = [
          'hf_whoami', 'space_search', 'model_search', 'paper_search', 
          'dataset_search', 'hub_repo_details', 'hf_doc_search', 
          'hf_doc_fetch', 'gr1_flux1_schnell_infer'
        ];
        functionCount = availableFunctions.length;
      } else if (toolName === 'parallel_web_search') {
        availableFunctions = ['web_search_preview'];
        functionCount = 1;
      } else if (toolName === 'github') {
        availableFunctions = ['github_operations']; // GitHub tools may vary
        functionCount = 1;
      } else {
        // For unknown tools, we could optionally discover them, but prefer not to
        // unless specifically needed for execution
        availableFunctions = ['general_operations'];
        functionCount = 1;
      }
      
      const toolInfo = {
        name: toolName,
        description: tool._meta?.description || tool.server_label || 'MCP tool',
        use_cases: tool._meta?.use_cases || [],
        server_url: tool.server_url,
        hasRemote: true,
        available_functions: availableFunctions,
        function_count: functionCount
      };
      
      localRegistry.push(toolInfo);
    }

    // Add custom URLs as available tools if detected
    if (customUrls.length > 0) {
      customUrls.forEach(url => {
        try {
          const urlObj = new URL(url);
          localRegistry.push({
            name: url,
            description: `Custom MCP server at ${urlObj.hostname}`,
            use_cases: ['Custom operations'],
            server_url: url,
            hasRemote: true,
            available_functions: ['custom_operations'],
            function_count: 1,
            source: 'dynamic_url'
          });
        } catch (error) {
          console.warn('Invalid custom URL:', url);
        }
      });
    }

    // Get public registry context (filtered for relevant tools with remotes)
    let publicRegistry = [];
    try {
      const registryUrl = 'https://registry.modelcontextprotocol.io/v0/servers';
      const response = await fetch(registryUrl);
      
      if (response.ok) {
        const data = await response.json();
        publicRegistry = (data.servers || [])
          .filter(server => server.remotes && server.remotes.length > 0) // Only tools with remotes (runnable through Groq)
          .map(server => ({
            name: server.name,
            description: server.description || 'MCP server',
            remotes: server.remotes,
            server_url: server.remotes.find(r => r.type === 'streamable-http')?.url || server.remotes[0]?.url
          }))
          .slice(0, 100); // Provide more tools for better AI awareness
      }
  } catch (error) {
      console.warn('Failed to fetch public registry:', error.message);
    }

    // Use LLM router to determine the appropriate response type
    const routingDecision = await llmRouter(userQuery, apiKey, model, conversationHistory);

    if (routingDecision.type === 'introspection') {
      // Check if user is asking about a specific MCP server's tools
      const specificServerMatch = userQuery.match(/(?:tools?|available|what|list).*(?:for|from|in|of)\s+([a-zA-Z0-9._\/-]+(?:mcp|server))/i) ||
                                  userQuery.match(/([a-zA-Z0-9._\/-]+(?:mcp|server)).*(?:tools?|available|what|functions)/i) ||
                                  userQuery.match(/(garden\.stanislav\.svelte-llm\/svelte-llm-mcp|ai\.waystation\/gmail|com\.apple-rag\/mcp-server|com\.biodnd\/agent-ip)/i);
      
      if (specificServerMatch) {
        const serverName = specificServerMatch[1];
        console.log(`Detected specific MCP server query: "${serverName}"`);
        
        try {
          // Make actual API call to list tools from the specific server
          const toolListingResult = await handleToolListing(serverName, model, apiKey);
          
          if (!toolListingResult.error && toolListingResult.response.schemas?.length > 0) {
            const schema = toolListingResult.response.schemas[0];
            
            if (schema.tools && schema.tools.length > 0) {
              // Format the actual tools discovered from the MCP server
              const toolsTable = schema.tools.map(tool => 
                `**${tool.name}**: ${tool.description || 'No description available'}`
              ).join('\n');
              
              return {
                introspection: true,
                response: `Here are the actual tools available from **${schema.server_label || serverName}**:\n\n${toolsTable}\n\n**Total tools:** ${schema.tool_count}\n**Source:** ${schema.source}\n\nThese tools were discovered by making a live API call to the MCP server.`,
                specific_server: serverName,
                discovered_tools: schema.tools,
                tool_count: schema.tool_count
              };
            } else if (schema.status === 'inaccessible') {
              return {
                introspection: true,
                response: `The MCP server **${serverName}** is currently inaccessible: ${schema.reason}\n\nThis means the server is configured but may need proper API keys or authentication to list its tools.`,
                specific_server: serverName,
                status: 'inaccessible',
                reason: schema.reason
              };
            }
          }
        } catch (error) {
          console.warn(`Failed to get tools for ${serverName}:`, error.message);
          // Fall back to general introspection below
        }
      }
      
      // Handle introspection queries by having AI respond conversationally about available tools/models
      const availableModels = [
        "openai/gpt-oss-120b", 
        "openai/gpt-oss-20b",
        "qwen/qwen3-32b",
        "moonshotai/kimi-k2-instruct-0905",
        "meta-llama/llama-4-maverick-17b-128e-instruct",
        "meta-llama/llama-4-scout-17b-16e-instruct",
        "llama-3.3-70b-versatile",
        "llama-3.1-8b-instant"
      ];

      // Build conversation context
      let conversationContext = '';
      if (conversationHistory.length > 0) {
        conversationContext = '\n\nCONVERSATION HISTORY:\n';
        conversationHistory.forEach((msg, index) => {
          const speaker = msg.type === 'user' ? 'User' : 'Assistant';
          conversationContext += `${speaker}: ${msg.content}\n`;
        });
        conversationContext += '\n';
      }

      const introspectionPrompt = `You are a helpful AI assistant that can see all the available tools and models in this MCP Navigation system. Answer the user's question naturally and conversationally based on what you can observe.${conversationContext}

CURRENT USER QUERY: "${userQuery}"

NOTE: When users ask about "MCPs", "MCP tools", "tools", or "servers", they want to see ALL available tools in both the local and public registries. Every tool listed below is an MCP-compatible tool that can be used in this system.

AVAILABLE MODELS:
${availableModels.map(model => `- ${model}`).join('\n')}

LOCAL REGISTRY TOOLS:
${localRegistry.map(tool => `- ${tool.name}: ${tool.description} (Use cases: ${tool.use_cases.join(', ') || 'General purpose'}) [${tool.function_count} functions: ${tool.available_functions.join(', ')}]`).join('\n')}

PUBLIC REGISTRY TOOLS:
${publicRegistry.map(tool => `${tool.name}: ${tool.description}`).join('\n')}

SYSTEM INFORMATION:
- This system can use any tool from the local registry or public MCP registry automatically
- Users can specify models in their requests
- Tools are accessed via MCP (Model Context Protocol)
- Public registry tools work without additional setup
- ALL tools listed above are available MCP tools, regardless of their naming convention

FORMATTING INSTRUCTIONS: When listing tools, use this exact format:

**Available Models:**
[List models with dashes]

**Local Registry Tools:**
[List with descriptions and use cases]

**Public Registry Tools:**
[List in format: tool.name: description (no dashes)]

IMPORTANT: When asked to list tools, ALWAYS show ALL tools from both local and public registries in the clean format above. Don't filter by name patterns - every tool listed above is an MCP tool that users can access. Be comprehensive and include everything you can see.`;

      // Get AI response about the tools/models
      const introspectionResponse = await groqResponses(apiKey, model, introspectionPrompt, []);
      
      // Extract response text
      let responseText = '';
      if (introspectionResponse.output && Array.isArray(introspectionResponse.output)) {
        const messageOutput = introspectionResponse.output.find(item => 
          item.type === 'message' && 
          item.content && 
          Array.isArray(item.content)
        );
        
        if (messageOutput) {
          const textContent = messageOutput.content.find(content => 
            content.type === 'output_text' && content.text
          );
          if (textContent) {
            responseText = textContent.text;
          }
        }
      }
      
      // Fallback to other possible formats
      if (!responseText) {
        responseText = introspectionResponse.choices?.[0]?.message?.content || 
                      introspectionResponse.content ||
                      'Unable to generate response about available tools/models.';
      }
      
      return {
        introspection: true,
        response: responseText,
        available_tools: localRegistry,
        available_models: availableModels,
        public_registry_sample: publicRegistry.slice(0, 10)
      };
    }

    if (routingDecision.type === 'direct_response') {
      // AI can answer directly without tools
      const directResponse = await groqResponses(apiKey, model, routingDecision.prompt, []);
      
      // Extract response text
      let responseText = '';
      if (directResponse.output && Array.isArray(directResponse.output)) {
        const messageOutput = directResponse.output.find(item => 
          item.type === 'message' && 
          item.content && 
          Array.isArray(item.content)
        );
        
        if (messageOutput) {
          const textContent = messageOutput.content.find(content => 
            content.type === 'output_text' && content.text
          );
          if (textContent) {
            responseText = textContent.text;
          }
        }
      }
      
      // Fallback to other possible formats
      if (!responseText) {
        responseText = directResponse.choices?.[0]?.message?.content || 
                      directResponse.content ||
                      'Unable to generate direct response.';
      }
      
      return {
        direct_response: true,
        response: responseText
      };
    }

    if (routingDecision.type === 'curl_generation') {
      // Detect which specific tool the user is asking about
      let targetTool = null;
      const queryLower = userQuery.toLowerCase();
      
      // Check for specific tool mentions
      if (queryLower.includes('github')) {
        targetTool = localRegistry.find(tool => tool.name === 'github');
      } else if (queryLower.includes('huggingface') || queryLower.includes('hugging face')) {
        targetTool = localRegistry.find(tool => tool.name === 'huggingface');
      } else if (queryLower.includes('web search') || queryLower.includes('parallel')) {
        targetTool = localRegistry.find(tool => tool.name === 'parallel_web_search');
      }
      
      // Default to first tool if no specific tool mentioned
      if (!targetTool) {
        targetTool = localRegistry[0];
      }
      
      if (targetTool) {
        const toolConfig = toolsRegistry[targetTool.name];
        const resolvedConfig = resolveToolConfig(toolConfig, {});
        
        const toolsJson = JSON.stringify([resolvedConfig], null, 2);
        const formattedTools = toolsJson.split('\n').map((line, index) => {
          if (index === 0) return line;
          return '    ' + line;
        }).join('\n');
        
        // Use a generic example query for curl demonstration
        const exampleQuery = "Create a new issue in my repository with the title 'Bug Report' and describe the issue";
        
        const curlCommand = `curl -X POST "https://api.groq.com/openai/v1/responses" \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "input": "${exampleQuery}",
    "tools": ${formattedTools}
  }'`;
        
        return {
          curl_generation: true,
          response: `Here's how to use the **${targetTool.name}** tool with the Groq Responses API:\n\nThis uses the official Groq API format for MCP tool execution:`,
          curl_command: curlCommand,
          selected_tools: [{ name: targetTool.name }]
        };
      }
    }

    // Create the selection prompt for regular tool execution
    // Build conversation context for tool selection too
    let conversationContext = '';
    const discoveredServers = extractDiscoveredServers(conversationHistory);
    
    if (conversationHistory.length > 0) {
      conversationContext = '\n\nCONVERSATION HISTORY:\n';
      conversationHistory.forEach((msg, index) => {
        const speaker = msg.type === 'user' ? 'User' : 'Assistant';
        conversationContext += `${speaker}: ${msg.content}\n`;
      });
      conversationContext += '\n';
    }
    
    // Add discovered servers context
    let discoveredContext = '';
    if (discoveredServers.size > 0) {
      discoveredContext = '\nDISCOVERED MCP SERVERS FROM CONVERSATION:\n';
      for (const [serverUrl, serverInfo] of discoveredServers) {
        discoveredContext += `- ${serverUrl}: ${serverInfo.tools.join(', ')}\n`;
      }
      discoveredContext += '\nNOTE: You can use any of these discovered tools by name, even if they\'re not in the main registries below.\n';
    }

    const selectionPrompt = `You are an AI assistant that helps users select the most appropriate MCP (Model Context Protocol) tools for their queries.${conversationContext}${discoveredContext}

CURRENT USER QUERY: "${cleanedQuery}"

AVAILABLE TOOLS:

LOCAL REGISTRY:
${localRegistry.map(tool => `- ${tool.name}: ${tool.description} (${tool.use_cases.join(', ')})`).join('\n')}

DISCOVERED FROM CONVERSATION:
${Array.from(discoveredServers.values()).flatMap(server => 
  server.tools.map(toolName => `- ${toolName}: Available from ${server.url}`)
).join('\n') || '(none)'}

PUBLIC REGISTRY (sample of available tools):
${publicRegistry.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

YOUR TASK:
1. Analyze the user query and determine which tool(s) would be most helpful
2. Select 1-3 most relevant tools (prefer LOCAL tools, then DISCOVERED tools, then PUBLIC tools)
3. Respond with ONLY a JSON object in this exact format:

{
  "selected_tools": [
    {
      "name": "tool_name",
      "reason": "why this tool is relevant",
      "registry": "local" or "discovered" or "public"
    }
  ],
  "execution_query": "natural language query to send to the selected tools - DO NOT format as function calls"
}

IMPORTANT: The execution_query should be natural language that describes what the user wants, NOT a function call format. For example:
- Good: "what's the weather in San Francisco"
- Bad: "web_search_preview(query='weather in SF')"

Be concise and practical. Choose tools that can actually help answer the user's question.`;

    // Get AI tool selection (no tools provided - this is just for selection, not execution)
    const selectionResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: "user", content: selectionPrompt }],
        temperature: 0.1
      })
    });
    
    if (!selectionResponse.ok) {
      const errorText = await selectionResponse.text();
      throw new Error(`Tool selection API error: ${selectionResponse.status} - ${errorText}`);
    }
    
    const selectionData = await selectionResponse.json();
    
    // Parse the AI response
    let selectedTools;
    try {
      // Extract JSON from the standard chat completion response
      let responseText = selectionData.choices?.[0]?.message?.content || '';
      
      // Ensure responseText is a string before calling .match()
      if (typeof responseText !== 'string') {
        responseText = JSON.stringify(responseText);
      }
      
      // Try to find JSON in the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        selectedTools = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in AI response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      console.error('Response structure:', JSON.stringify(selectionData, null, 2));
      return {
        error: 'Failed to parse AI tool selection',
        aiResponse: selectionData,
        parseError: parseError.message
      };
    }

    if (mode === 'curl') {
      // Generate curl command with conversation history
      return await generateCurlCommand(selectedTools, apiKey, model, conversationHistory);
    } else {
      // Execute the selected tools with merged headers (extracted + provided) and conversation history
      return await executeSelectedTools(selectedTools, apiKey, model, mergedToolHeaders, conversationHistory);
    }

  } catch (error) {
    console.error('AI tool selection error:', error);
    return {
      error: 'AI tool selection failed: ' + error.message,
      statusCode: 500
    };
  }
}
