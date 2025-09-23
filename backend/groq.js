import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown

// Groq Responses API wrapper function
export async function groqResponses(apiKey, model, input, tools = []) {
  try {
    const payload = {
      model,
      input,
      tools
    };

    console.log('Groq API Request:', JSON.stringify(payload, null, 2));

    const response = await fetch("https://api.groq.com/openai/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    console.log('Groq API Response Status:', response.status);
    console.log('Groq API Response:', responseText);

    if (!response.ok) {
      // Try to parse the error response to get more specific error info
      try {
        const errorData = JSON.parse(responseText);
        if (errorData?.error?.message?.includes('401 (Unauthorized)')) {
          throw new Error(`Authentication failed: The MCP tool requires a valid API key. Check your environment variables. Details: ${errorData.error.message}`);
        }
        if (errorData?.error?.message?.includes('tool call validation failed')) {
          // Extract the attempted tool name and suggest alternatives
          const failedGeneration = errorData.error.failed_generation;
          let toolNameSuggestion = '';
          if (failedGeneration) {
            try {
              const parsed = JSON.parse(failedGeneration);
              const attemptedTool = parsed.name;
              if (attemptedTool && attemptedTool.includes('__')) {
                const baseTool = attemptedTool.split('__')[0];
                toolNameSuggestion = ` The AI tried to call '${attemptedTool}' but only '${baseTool}' is registered. This suggests the tool schema needs to be updated to include the actual available functions.`;
              }
            } catch (_) {}
          }
          throw new Error(`Tool validation error: The AI tried to call a tool function that doesn't exist.${toolNameSuggestion} Details: ${errorData.error.message}`);
        }
        if (errorData?.error?.message) {
          throw new Error(`Groq API error (${response.status}): ${errorData.error.message}`);
        }
      } catch (parseError) {
        // If we can't parse the error, fall back to original format
      }
      throw new Error(`Groq API error: ${response.status} ${response.statusText} - ${responseText}`);
    }

    return JSON.parse(responseText);
  } catch (error) {
    console.error('Groq Responses API error:', error);
    
    // Add more detailed logging for debugging MCP server issues
    if (tools && tools.length > 0) {
      console.error('Failed request details:');
      console.error('- Model:', model);
      console.error('- Input:', input);
      console.error('- Tools:', JSON.stringify(tools, null, 2));
      
      // Check if this is an MCP server issue
      const mcpTools = tools.filter(tool => tool.type === 'mcp');
      if (mcpTools.length > 0) {
        console.error('MCP Server URLs involved:');
        mcpTools.forEach((tool, index) => {
          console.error(`  ${index + 1}. ${tool.server_url} (${tool.server_label})`);
        });
      }
    }
    
    throw error;
  }
}
