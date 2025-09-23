import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown
import { groqResponses } from './groq.js';
import { toolsRegistry, resolveToolConfig } from './tools.js';
import { lookupFromMcpRegistry } from './registry.js';

// LLM Router function to determine if we need tools or can answer directly
export async function llmRouter(userQuery, apiKey, model, conversationHistory = []) {
  try {
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

    const systemPrompt = `You are a smart routing assistant that determines how to handle user queries in an MCP Navigation system.

AVAILABLE RESPONSE TYPES:
1. "introspection" - User wants to know about available tools/models/system capabilities
2. "direct_response" - Question can be answered with general knowledge, no external tools needed
3. "tool_execution" - User needs external tools/APIs to get current data or perform actions
4. "curl_generation" - User wants to see curl command examples for using MCP tools with Groq API

EXAMPLES:
- "show all tools" → introspection
- "what tools are available in garden.stanislav.svelte-llm/svelte-llm-mcp" → introspection
- "list tools from ai.waystation/gmail MCP server" → introspection  
- "what functions does com.apple-rag/mcp-server have" → introspection
- "tools available for garden.stanislav.svelte-llm/svelte-llm-mcp" → introspection
- "check what's available at https://example.com/mcp" → introspection
- "what tools are at https://my-server.com/mcp" → introspection
- "list endpoints from https://api.example.com/mcp" → introspection
- "how do I use git?" → direct_response
- "what's the weather today?" → tool_execution
- "explain machine learning" → direct_response
- "show me a curl example for github tool" → curl_generation
- "generate a curl command for huggingface MCP tool" → curl_generation
- "how do I call the MCP tool with curl using Groq Responses API?" → curl_generation
- "curl example for MCP tools" → curl_generation
- "Groq Responses API curl command for tools" → curl_generation
- "Show me how to use the GitHub MCP tool" → curl_generation
- "how to use the [tool name] MCP tool" → curl_generation
- "show me how to use [any MCP tool]" → curl_generation
- "search for recent papers on AI" → tool_execution

SPECIAL CASES:
- When user provides a URL (http/https) and asks to "check", "list", "available", "what's at", etc. → introspection
- URLs should be treated as requests to discover what's available at that endpoint

NOTE: curl_generation is specifically for MCP tool usage with the Groq Responses API (/openai/v1/responses endpoint), not general curl examples or Chat Completions API.`;

    const userMessage = `${conversationContext}CURRENT USER QUERY: "${userQuery}"

Analyze this query and determine the appropriate response type.`;

    // Use Groq Chat Completions with structured output for reliable JSON parsing
    const routingResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage }
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "routing_decision",
            schema: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["introspection", "direct_response", "tool_execution", "curl_generation"]
                },
                reasoning: {
                  type: "string",
                  description: "Brief explanation of why this response type was chosen"
                },
                prompt: {
                  type: "string",
                  description: "For direct_response type only: prompt for answering directly with general knowledge"
                }
              },
              required: ["type", "reasoning"],
              additionalProperties: false
            }
          }
        },
        temperature: 0.1
      })
    });

    if (!routingResponse.ok) {
      const errorText = await routingResponse.text();
      throw new Error(`Routing API error: ${routingResponse.status} - ${errorText}`);
    }

    const routingData = await routingResponse.json();
    
    // Extract structured response from Chat Completions API
    const decision = routingData.choices?.[0]?.message?.content;
    
    if (decision) {
      try {
        const parsedDecision = JSON.parse(decision);
        
        // Validate the required fields
        if (parsedDecision.type && parsedDecision.reasoning) {
          // Debug logging to see routing decisions
          console.log(`LLM Router decision for query "${userQuery}":`, JSON.stringify(parsedDecision, null, 2));
          
          // For direct_response, ensure we have a prompt or generate one
          if (parsedDecision.type === 'direct_response' && !parsedDecision.prompt) {
            parsedDecision.prompt = `You are a helpful AI assistant. ${conversationContext} Answer the user's question: '${userQuery}' using your general knowledge. Be conversational and helpful.`;
          }
          
          return parsedDecision;
        }
      } catch (parseError) {
        console.warn('Failed to parse routing decision JSON:', parseError);
        console.warn('Response content:', decision);
      }
    }
    
    // Fallback to tool execution if routing fails
    return { type: 'tool_execution', reasoning: 'routing failed, defaulting to tool execution' };
    
  } catch (error) {
    console.error('LLM router error:', error);
    return { type: 'tool_execution', reasoning: 'router error, defaulting to tool execution' };
  }
}

// Generate curl command for selected tools using Groq Responses API pattern
export async function generateCurlCommand(selectedTools, apiKey, model, conversationHistory = []) {
  // Import the discovery functions
  const { extractDiscoveredServers, findServerForTool, createConfigFromUrl } = await import('./handlers.js');
  
  // Extract discovered servers from conversation history
  const discoveredServers = extractDiscoveredServers(conversationHistory);
  
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
          console.log(`Using discovered tool '${selected.name}' for curl generation from ${serverUrl}`);
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

  // Format tools for better readability while keeping it functional
  const toolsJson = JSON.stringify(tools, null, 2);
  const formattedTools = toolsJson.split('\n').map((line, index) => {
    if (index === 0) return line; // Don't indent first line
    return '    ' + line; // Indent subsequent lines
  }).join('\n');

  const curlCommand = `curl -X POST "https://api.groq.com/openai/v1/responses" \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "input": "${selectedTools.execution_query || 'Your query here'}",
    "tools": ${formattedTools}
  }'`;

  return {
    mode: 'curl',
    selected_tools: selectedTools.selected_tools,
    execution_query: selectedTools.execution_query,
    curl_command: curlCommand,
    tools_config: tools
  };
}
