export default function mcpNavApp() {
  const inst = {
    // API key management
    hasServerKey: true,
    hasServerParallelKey: false,
    userApiKey: '', // Groq API key
    parallelApiKey: '', // Parallel API key
    apiKeyInput: '',
    parallelKeyInput: '',
    showApiKeyPanel: false,
    
    // Dynamic API key management
    customApiKeys: {}, // { keyName: { name, value, description } }
    newApiKeyName: '',
    newApiKeyValue: '',
    newApiKeyDescription: '',
    showAddApiKeyForm: false,

    // Chat state
    messages: [], // Array of { type: 'user'|'assistant', content: string, timestamp: Date, tools?: array, curl?: string, loading?: boolean }
    currentInput: '',
    isProcessing: false,
    
    // Available models
    selectedModel: "openai/gpt-oss-120b",
    availableModels: [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3-32b",
      "moonshotai/kimi-k2-instruct-0905",
      "meta-llama/llama-4-maverick-17b-128e-instruct",
      "meta-llama/llama-4-scout-17b-16e-instruct",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant"
    ],

    async init() {
      // Load API keys from localStorage
      try {
        const storedGroqKey = localStorage.getItem('groq_api_key');
        if (storedGroqKey) this.userApiKey = storedGroqKey;
        
        const storedParallelKey = localStorage.getItem('parallel_api_key');
        if (storedParallelKey) this.parallelApiKey = storedParallelKey;
        
        // Load custom API keys
        const storedCustomKeys = localStorage.getItem('custom_api_keys');
        if (storedCustomKeys) this.customApiKeys = JSON.parse(storedCustomKeys);
      } catch (_) {}
      
      await this.checkServerKeys();
      
      // Load chat history from localStorage
      try {
        const storedMessages = localStorage.getItem('mcp_nav_messages');
        if (storedMessages) {
          this.messages = JSON.parse(storedMessages);
          // Clean up any loading states from previous session
          this.messages.forEach(msg => {
            if (msg.loading) msg.loading = false;
          });
        }
      } catch (_) {}

      // Load model preference
      try {
        const storedModel = localStorage.getItem('mcp_nav_model');
        if (storedModel && this.availableModels.includes(storedModel)) {
          this.selectedModel = storedModel;
        }
      } catch (_) {}
    },

    async checkServerKeys() {
      try {
        const r = await fetch('/api/debug');
        const j = await r.json();
        this.hasServerKey = !!j.environment?.GROQ_API_KEY?.includes('Available');
        this.hasServerParallelKey = !!j.environment?.PARALLEL_API_KEY?.includes('Available');
      } catch (_) { 
        this.hasServerKey = false; 
        this.hasServerParallelKey = false;
      }
    },

    // API Key management
    setGroqApiKey() {
      if (this.apiKeyInput && this.apiKeyInput.trim()) {
        this.userApiKey = this.apiKeyInput.trim();
        try { localStorage.setItem('groq_api_key', this.userApiKey); } catch (_) {}
        this.apiKeyInput = '';
      }
    },
    
    setParallelApiKey() {
      if (this.parallelKeyInput && this.parallelKeyInput.trim()) {
        this.parallelApiKey = this.parallelKeyInput.trim();
        try { localStorage.setItem('parallel_api_key', this.parallelApiKey); } catch (_) {}
        this.parallelKeyInput = '';
      }
    },
    
    clearGroqApiKey() { 
      this.userApiKey = ''; 
      try { localStorage.removeItem('groq_api_key'); } catch (_) {} 
    },
    
    clearParallelApiKey() { 
      this.parallelApiKey = ''; 
      try { localStorage.removeItem('parallel_api_key'); } catch (_) {} 
    },
    
    // Custom API key management
    addCustomApiKey() {
      if (this.newApiKeyName && this.newApiKeyValue) {
        this.customApiKeys[this.newApiKeyName] = {
          name: this.newApiKeyName,
          value: this.newApiKeyValue.trim(),
          description: this.newApiKeyDescription || `API key for ${this.newApiKeyName}`
        };
        this.saveCustomApiKeys();
        this.resetAddApiKeyForm();
      }
    },
    
    removeCustomApiKey(keyName) {
      delete this.customApiKeys[keyName];
      this.saveCustomApiKeys();
    },
    
    saveCustomApiKeys() {
      try {
        localStorage.setItem('custom_api_keys', JSON.stringify(this.customApiKeys));
      } catch (_) {}
    },
    
    resetAddApiKeyForm() {
      this.newApiKeyName = '';
      this.newApiKeyValue = '';
      this.newApiKeyDescription = '';
      this.showAddApiKeyForm = false;
    },
    
    toggleAddApiKeyForm() {
      this.showAddApiKeyForm = !this.showAddApiKeyForm;
      if (!this.showAddApiKeyForm) {
        this.resetAddApiKeyForm();
      }
    },
    
    maskedCustomKey(key) {
      if (!key || key.length < 8) return key;
      return key.substring(0, 4) + '*'.repeat(Math.max(0, key.length - 8)) + key.substring(key.length - 4);
    },
    
    // Build tool headers from all available API keys
    buildToolHeaders() {
      const headers = {};
      
      // Add parallel API key if available
      if (this.parallelApiKey) {
        headers["parallel_web_search"] = {
          "x-api-key": this.parallelApiKey
        };
      }
      
      // Add custom API keys - map them to potential tool names
      Object.entries(this.customApiKeys).forEach(([keyName, keyData]) => {
        const keyLower = keyName.toLowerCase();
        const cleanKeyName = keyLower.replace(/[^a-z0-9]/g, '_');
        
        // Support common header formats based on service type
        let headerConfig;
        if (keyLower.includes('github')) {
          headerConfig = { "Authorization": `Bearer ${keyData.value}` };
        } else if (keyLower.includes('hugging') || keyLower.includes('hf')) {
          headerConfig = { "Authorization": `Bearer ${keyData.value}` };
        } else if (keyLower.includes('openai') || keyLower.includes('gpt')) {
          headerConfig = { "Authorization": `Bearer ${keyData.value}` };
        } else if (keyLower.includes('anthropic') || keyLower.includes('claude')) {
          headerConfig = { "x-api-key": keyData.value };
        } else if (keyLower.includes('google') || keyLower.includes('gemini')) {
          headerConfig = { "Authorization": `Bearer ${keyData.value}` };
        } else if (keyLower.includes('parallel') || keyLower.includes('search')) {
          headerConfig = { "x-api-key": keyData.value };
        } else {
          // Default to x-api-key header format
          headerConfig = { "x-api-key": keyData.value };
        }
        
        // Add mappings for various potential tool name formats
        const possibleToolNames = [
          keyName,                    // Exact key name
          cleanKeyName,              // Cleaned key name
          keyLower,                  // Lowercase
          keyName.replace(/[-_]/g, ''), // No separators
          keyLower.replace(/[-_]/g, ''), // No separators lowercase
        ];
        
        // Add specific mappings for known services
        if (keyLower.includes('github')) {
          possibleToolNames.push('github', 'com.github.copilot', 'github_operations');
        } else if (keyLower.includes('hugging') || keyLower.includes('hf')) {
          possibleToolNames.push('huggingface', 'hf', 'hugging_face');
        } else if (keyLower.includes('parallel')) {
          possibleToolNames.push('parallel_web_search', 'parallel', 'web_search');
        } else if (keyLower.includes('gmail') || keyLower.includes('google')) {
          possibleToolNames.push('gmail', 'ai.waystation/gmail', 'google');
        } else if (keyLower.includes('apple')) {
          possibleToolNames.push('com.apple-rag/mcp-server', 'apple_docs');
        }
        
        // Apply the header config to all possible tool names
        possibleToolNames.forEach(toolName => {
          if (toolName && toolName.trim()) {
            headers[toolName.trim()] = headerConfig;
          }
        });
      });
      
      return headers;
    },
    
    toggleApiKeyPanel() {
      this.showApiKeyPanel = !this.showApiKeyPanel;
    },
    
    get maskedGroqKey() {
      if (!this.userApiKey) return '';
      const k = this.userApiKey;
      return k.substring(0, 8) + '*'.repeat(Math.max(0, k.length - 12)) + k.substring(k.length - 4);
    },
    
    get maskedParallelKey() {
      if (!this.parallelApiKey) return '';
      const k = this.parallelApiKey;
      return k.substring(0, 8) + '*'.repeat(Math.max(0, k.length - 12)) + k.substring(k.length - 4);
    },
    
    get apiKeyStatus() {
      const groqStatus = this.userApiKey || this.hasServerKey;
      const parallelStatus = this.parallelApiKey || this.hasServerParallelKey;
      return { groq: groqStatus, parallel: parallelStatus };
    },

    // Enhanced error handling for API key issues
    handleApiError(response, errorText) {
      const status = response.status;
      let errorMessage = errorText;
      let suggestions = [];

      // Parse JSON error if possible
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorText;
      } catch (_) {}

      if (status === 401 || errorMessage.toLowerCase().includes('api key') || errorMessage.toLowerCase().includes('authentication')) {
        suggestions.push("🔑 **API Key Issue Detected**");
        
        if (!this.userApiKey && !this.hasServerKey) {
          suggestions.push("• Add your Groq API key using the 'Manage' button above");
        }
        
        if (errorMessage.toLowerCase().includes('parallel') && !this.parallelApiKey && !this.hasServerParallelKey) {
          suggestions.push("• Add your Parallel API key for web search functionality");
        }
        
        suggestions.push("• Check that your API keys are valid and have sufficient credits");
        suggestions.push("• User-provided keys take priority over server keys");
      } else if (status === 429) {
        suggestions.push("⏰ **Rate Limit Exceeded**");
        suggestions.push("• Wait a moment before making another request");
        suggestions.push("• Consider upgrading your API plan for higher limits");
      } else if (status >= 500) {
        suggestions.push("🔧 **Server Error**");
        suggestions.push("• This appears to be a temporary server issue");
        suggestions.push("• Try again in a few moments");
      }

      return {
        message: errorMessage,
        suggestions,
        showApiPanel: status === 401 || errorMessage.toLowerCase().includes('api key')
      };
    },

    // Model selection
    setModel(model) {
      this.selectedModel = model;
      try { localStorage.setItem('mcp_nav_model', model); } catch (_) {}
    },

    // Message management
    saveMessages() {
      try {
        localStorage.setItem('mcp_nav_messages', JSON.stringify(this.messages));
      } catch (_) {}
    },

    clearChat() {
      this.messages = [];
      this.saveMessages();
    },

    addUserMessage(content) {
      const message = {
        type: 'user',
        content: content,
        timestamp: new Date().toISOString()
      };
      this.messages.push(message);
      this.saveMessages();
      return message;
    },

    addAssistantMessage(content, tools = [], curl = '') {
      const message = {
        type: 'assistant',
        content: content,
        tools: tools,
        curl: curl,
        timestamp: new Date().toISOString(),
        loading: false
      };
      this.messages.push(message);
      this.saveMessages();
      return message;
    },

    addLoadingMessage() {
      const message = {
        type: 'assistant',
        content: 'Processing...',
        timestamp: new Date().toISOString(),
        loading: true
      };
      this.messages.push(message);
      this.saveMessages();
      return message;
    },

    updateLastMessage(updates) {
      if (this.messages.length > 0) {
        const lastMessage = this.messages[this.messages.length - 1];
        Object.assign(lastMessage, updates);
        this.saveMessages();
      }
    },

    // Chat interaction
    async sendMessage() {
      const input = this.currentInput.trim();
      if (!input || this.isProcessing) return;

      // Check for API key
      if (!this.hasServerKey && !this.userApiKey) {
        alert('Please set your Groq API key first.');
        return;
      }

      // Add user message
      this.addUserMessage(input);
      this.currentInput = '';
      
      // Add loading message
      const loadingMessage = this.addLoadingMessage();
      this.isProcessing = true;

      try {
        // Determine if this is a request for curl/code generation
        const isCurlRequest = this.isCurlGenerationRequest(input);
        
        if (isCurlRequest) {
          // Generate curl command without execution
          await this.generateCurlCommand(input, loadingMessage);
        } else {
          // Execute with tools
          await this.executeWithTools(input, loadingMessage);
        }
      } catch (error) {
        console.error('Chat error:', error);
        this.updateLastMessage({
          content: `Error: ${error.message}`,
          loading: false
        });
      } finally {
        this.isProcessing = false;
        this.scrollToBottom();
      }
    },

    isCurlGenerationRequest(input) {
      const curlKeywords = [
        'curl', 'code', 'example', 'generate', 'show me how',
        'api call', 'request', 'command', 'snippet'
      ];
      const lower = input.toLowerCase();
      return curlKeywords.some(keyword => lower.includes(keyword)) && 
             (lower.includes('tool') || lower.includes('mcp') || lower.includes('api'));
    },

    async generateCurlCommand(input, loadingMessage) {
      try {
        // Call the /api/select endpoint with curl mode
        const response = await fetch('/api/select', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.userApiKey ? { 'Authorization': `Bearer ${this.userApiKey}` } : {})
          },
          body: JSON.stringify({
            query: input,
            mode: 'curl',
            model: this.selectedModel,
            conversation_history: this.messages.slice(-10), // Send last 10 messages for context
            toolHeaders: this.buildToolHeaders()
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          const errorInfo = this.handleApiError(response, errorText);
          
          if (errorInfo.showApiPanel) {
            this.showApiKeyPanel = true;
          }
          
          let fullError = errorInfo.message;
          if (errorInfo.suggestions.length > 0) {
            fullError += '\n\n' + errorInfo.suggestions.join('\n');
          }
          
          throw new Error(fullError);
        }

        const result = await response.json();
        
        let content = "Here's the generated curl command:\n\n";
        if (result.selected_tools && result.selected_tools.length > 0) {
          content += `**Selected Tools:** ${result.selected_tools.map(t => t.name).join(', ')}\n\n`;
          content += `**Query:** ${result.execution_query}\n\n`;
        }

        // Clean up the curl command formatting and sanitize API keys
        let curlCommand = result.curl_command || '';
        if (curlCommand) {
          // Sanitize any API keys that might be in the curl command
          curlCommand = this.sanitizeCurlCommand(curlCommand);
          // Format the curl command for better readability in REST clients
          curlCommand = curlCommand.replace(/\s+/g, ' ').trim();
          // Add line breaks for better readability while keeping it functional
          curlCommand = curlCommand.replace(' -H ', ' \\\n  -H ').replace(' -d ', ' \\\n  -d ');
        }

        // Ensure tools is an array of objects with name property
        const tools = (result.selected_tools || []).map(tool => 
          typeof tool === 'string' ? { name: tool } : tool
        );

        // Generate SDK example for curl generation mode too
        let sdkExample = '';
        if (result.tools_config && result.tools_config.length > 0) {
          const query = result.execution_query || 'Your query here';
          let toolsJson = JSON.stringify(result.tools_config, null, 2);
          toolsJson = toolsJson.split('\n').map((line, index) => {
            if (index === 0) return line;
            return '  ' + line;
          }).join('\n');
          
          sdkExample = `import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const response = await client.responses.create({
  model: "${this.selectedModel}",
  input: "${query}",
  tools: ${toolsJson}
});

console.log(response);`;
        }

        this.updateLastMessage({
          content: content,
          curl: curlCommand,
          sdk: sdkExample,
          tools: tools,
          loading: false
        });
      } catch (error) {
        this.updateLastMessage({
          content: `Error generating curl command: ${error.message}`,
          loading: false
        });
      }
    },

    async executeWithTools(input, loadingMessage) {
      try {
        // Call the /api/select endpoint with execute mode
        const response = await fetch('/api/select', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.userApiKey ? { 'Authorization': `Bearer ${this.userApiKey}` } : {})
          },
          body: JSON.stringify({
            query: input,
            mode: 'execute',
            model: this.selectedModel,
            conversation_history: this.messages.slice(-10), // Send last 10 messages for context
            toolHeaders: this.buildToolHeaders()
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          const errorInfo = this.handleApiError(response, errorText);
          
          if (errorInfo.showApiPanel) {
            this.showApiKeyPanel = true;
          }
          
          let fullError = errorInfo.message;
          if (errorInfo.suggestions.length > 0) {
            fullError += '\n\n' + errorInfo.suggestions.join('\n');
          }
          
          throw new Error(fullError);
        }

        const result = await response.json();
        
        // Handle different response types
        if (result.introspection || result.direct_response || result.curl_generation) {
          // Ensure tools is an array of objects with name property
          const tools = (result.selected_tools || []).map(tool => 
            typeof tool === 'string' ? { name: tool } : tool
          );

          // If we expected curl generation but got direct response, try to enhance with curl
          let curlCommand = result.curl_command || '';
          if (result.direct_response && !curlCommand && this.isCurlGenerationRequest(input)) {
            // Generate a basic curl example for the mentioned tool
            curlCommand = this.generateBasicCurlExample(input);
          }

          this.updateLastMessage({
            content: result.response,
            curl: curlCommand,
            tools: tools,
            loading: false
          });
        } else {
          let content = this.formatExecutionResult(result);
          let curlCommand = this.generateCurlFromResult(result);

          // Ensure tools is an array of objects with name property
          const tools = (result.selected_tools || []).map(tool => 
            typeof tool === 'string' ? { name: tool } : tool
          );

          this.updateLastMessage({
            content: content,
            curl: curlCommand,
            tools: tools,
            loading: false
          });
        }
      } catch (error) {
        this.updateLastMessage({
          content: `Error executing query: ${error.message}`,
          loading: false
        });
      }
    },

    formatExecutionResult(result) {
      let content = '';
      
      // Check for errors first
      if (result.error) {
        const errorMsg = result.error;
        if (typeof errorMsg === 'string') {
          if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
            content = `**Authentication Error**: The MCP tool requires valid API credentials.\n\n`;
            content += `**Details**: ${errorMsg}\n\n`;
            content += `**Next Steps**:\n`;
            content += `- Check that you have the required API key for this tool\n`;
            content += `- Verify the API key has the necessary permissions\n`;
            content += `- Ensure the API key is properly configured in your environment`;
          } else if (errorMsg.includes('424') || errorMsg.includes('Failed Dependency')) {
            content = `**Tool Connection Error**: Unable to connect to the MCP server.\n\n`;
            content += `**Details**: ${errorMsg}\n\n`;
            content += `**Possible Causes**:\n`;
            content += `- Server is temporarily unavailable\n`;
            content += `- Authentication or permission issues\n`;
            content += `- Network connectivity problems`;
          } else {
            content = `**Error**: ${errorMsg}`;
          }
        } else {
          content = `**Error**: ${JSON.stringify(errorMsg, null, 2)}`;
        }
        return content;
      }
      
      if (result.selected_tools && result.selected_tools.length > 0) {
        content += `**Selected Tools:** ${result.selected_tools.map(t => `${t.name} (${t.reason})`).join(', ')}\n\n`;
      }
      
      if (result.execution_query) {
        content += `**Executed Query:** ${result.execution_query}\n\n`;
      }

      if (result.result) {
        content += "**Results:**\n\n";
        
        if (result.result.output && Array.isArray(result.result.output)) {
          for (const output of result.result.output) {
            if (output.type === 'message' && output.content) {
              const textContent = output.content.find(c => c.type === 'output_text');
              if (textContent) {
                content += textContent.text + '\n\n';
              }
            } else if (output.type === 'mcp_call_tool') {
              content += `**Tool Call:** ${output.name}\n`;
              if (output.result && output.result.content) {
                const textResult = output.result.content.find(c => c.type === 'text');
                if (textResult) {
                  content += textResult.text + '\n\n';
                }
              }
            }
          }
        } else if (typeof result.result === 'string') {
          content += result.result;
        } else {
          content += JSON.stringify(result.result, null, 2);
        }
      }

      return content || "No results returned.";
    },

    generateCurlFromResult(result) {
      if (!result.selected_tools || result.selected_tools.length === 0) return '';
      
      const query = result.execution_query || 'Your query here';
      
      // Use the actual tools_config if available from the result
      let toolsJson = '';
      if (result.tools_config && result.tools_config.length > 0) {
        // Create a sanitized copy of the tools config
        const sanitizedConfig = result.tools_config.map(tool => {
          const sanitized = { ...tool };
          
          // Sanitize headers to replace actual API keys with placeholders
          if (sanitized.headers) {
            const cleanHeaders = { ...sanitized.headers };
            Object.keys(cleanHeaders).forEach(key => {
              const value = cleanHeaders[key];
              if (typeof value === 'string' && value.length > 10) {
                // Replace potential API keys with descriptive placeholders
                if (key.toLowerCase().includes('api') || key.toLowerCase().includes('key') || key.toLowerCase().includes('auth')) {
                  if (key === 'x-api-key') {
                    cleanHeaders[key] = '<PARALLEL_API_KEY>';
                  } else if (key.toLowerCase().includes('github')) {
                    cleanHeaders[key] = '<GITHUB_TOKEN>';
                  } else if (key.toLowerCase().includes('hugging')) {
                    cleanHeaders[key] = '<HUGGINGFACE_TOKEN>';
                  } else {
                    cleanHeaders[key] = `<${key.toUpperCase().replace(/-/g, '_')}>`;
                  }
                }
              }
            });
            sanitized.headers = cleanHeaders;
          }
          
          return sanitized;
        });
        
        toolsJson = JSON.stringify(sanitizedConfig, null, 6);
        // Indent properly for the curl command (6 spaces to match the JSON formatting)
        toolsJson = toolsJson.split('\n').map((line, index) => {
          if (index === 0) return line;
          return '      ' + line;
        }).join('\n');
      } else {
        // Try to extract tool info from the result for fallback
        let toolUrl = 'https://your-mcp-server.com/mcp';
        let toolLabel = 'Custom MCP Server';
        
        if (result.selected_tools && result.selected_tools.length > 0) {
          const firstTool = result.selected_tools[0];
          // Check if the tool name is a URL
          if (firstTool.name && (firstTool.name.startsWith('http://') || firstTool.name.startsWith('https://'))) {
            toolUrl = firstTool.name;
            try {
              const urlObj = new URL(toolUrl);
              toolLabel = `Custom MCP Server (${urlObj.hostname})`;
            } catch (e) {
              // Keep default label if URL parsing fails
            }
          }
        }
        
        // Fallback to placeholder if no actual config available
        toolsJson = `[
        {
          "type": "mcp",
          "server_label": "${toolLabel}",
          "server_url": "${toolUrl}",
          "headers": {},
          "require_approval": "never"
        }
      ]`;
      }
      
      // Generate a Groq Responses API curl command
      return `curl -X POST "https://api.groq.com/openai/v1/responses" \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${this.selectedModel}",
    "input": "${query}",
    "tools": ${toolsJson}
  }'`;
    },

    // Sanitize curl commands to replace API keys with placeholders
    sanitizeCurlCommand(curlCommand) {
      let sanitized = curlCommand;
      
      // Replace actual API key values with placeholders based on custom keys
      Object.entries(this.customApiKeys).forEach(([keyName, keyData]) => {
        const keyValue = keyData.value;
        if (keyValue && keyValue.length > 10) {
          // Replace the actual key value with a descriptive placeholder
          const placeholder = `<${keyName.toUpperCase()}_API_KEY>`;
          sanitized = sanitized.replace(new RegExp(escapeRegExp(keyValue), 'g'), placeholder);
        }
      });
      
      // Replace parallel API key if present
      if (this.parallelApiKey) {
        sanitized = sanitized.replace(new RegExp(escapeRegExp(this.parallelApiKey), 'g'), '<PARALLEL_API_KEY>');
      }
      
      // Replace common API key patterns with generic placeholders
      return sanitized
        .replace(/"x-api-key":\s*"[^"]+"/g, '"x-api-key": "<API_KEY>"')
        .replace(/"Authorization":\s*"Bearer [^"]+"/g, '"Authorization": "Bearer <API_TOKEN>"')
        .replace(/"authorization":\s*"Bearer [^"]+"/g, '"authorization": "Bearer <API_TOKEN>"')
        .replace(/Bearer [a-zA-Z0-9_-]{20,}/g, 'Bearer <API_TOKEN>')
        .replace(/"[a-zA-Z0-9_-]{30,}"/g, (match) => {
          // Only replace if it looks like an API key (long alphanumeric string)
          if (match.length > 32 && /^"[a-zA-Z0-9_-]+$/.test(match.slice(0, -1) + '"')) {
            return '"<API_KEY>"';
          }
          return match;
        });
      
      // Helper function to escape regex special characters
      function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    },

    // Generate a basic curl example when routing fails
    generateBasicCurlExample(input) {
      const lower = input.toLowerCase();
      let toolName = 'github';
      let toolConfig = {};
      let query = 'Create a new issue in my repository with the title "Bug Report"';
      
      // Detect which tool is being asked about
      if (lower.includes('github')) {
        toolName = 'github';
        toolConfig = {
          "type": "mcp",
          "server_label": "GitHub",
          "server_url": "https://api.githubcopilot.com/mcp/",
          "headers": {
            "Authorization": "Bearer <GITHUB_TOKEN>"
          },
          "require_approval": "never"
        };
        query = 'Create a new issue in my repository with the title "Bug Report"';
      } else if (lower.includes('huggingface') || lower.includes('hugging face')) {
        toolName = 'huggingface';
        toolConfig = {
          "type": "mcp",
          "server_label": "Huggingface",
          "server_url": "https://huggingface.co/mcp",
          "headers": {},
          "require_approval": "never"
        };
        query = 'Find trending AI models this week';
      } else if (lower.includes('web search') || lower.includes('parallel')) {
        toolName = 'parallel_web_search';
        toolConfig = {
          "type": "mcp",
          "server_label": "parallel_web_search",
          "server_url": "https://mcp.parallel.ai/v1beta/search_mcp/",
          "headers": {
            "x-api-key": "<PARALLEL_API_KEY>"
          },
          "require_approval": "never"
        };
        query = "What's the weather in San Francisco";
      }
      
      const toolsJson = JSON.stringify([toolConfig], null, 6);
      const formattedTools = toolsJson.split('\n').map((line, index) => {
        if (index === 0) return line;
        return '      ' + line;
      }).join('\n');
      
      return `curl -X POST "https://api.groq.com/openai/v1/responses" \\
  -H "Authorization: Bearer $GROQ_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${this.selectedModel}",
    "input": "${query}",
    "tools": ${formattedTools}
  }'`;
    },

    // UI helpers
    scrollToBottom() {
      // Use nextTick equivalent
      setTimeout(() => {
        const chatContainer = document.querySelector('.chat-container');
        if (chatContainer) {
          chatContainer.scrollTop = chatContainer.scrollHeight;
        }
      }, 100);
    },

    formatTimestamp(timestamp) {
      try {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch (_) {
        return '';
      }
    },

    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch (_) {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
    },

    // Handle enter key in input
    handleKeyDown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendMessage();
      }
    },

    // Try example function for clickable examples
    tryExample(exampleText) {
      if (this.isProcessing) return; // Don't allow if already processing
      
      this.currentInput = exampleText;
      // Use a small delay to ensure the input is updated before sending
      setTimeout(() => {
        this.sendMessage();
      }, 50);
    },

    // i18n
    get i18n() {
      return {
        title: 'MCP Navigator',
        subtitle: 'AI-powered tool selection and execution using Model Context Protocol',
        apiKey: 'API Key:',
        change: 'Change',
        clear: 'Clear',
        getKeyHere: 'Get your free key here',
        placeholder: 'Ask me anything or request a tool example...',
        send: 'Send',
        clearChat: 'Clear Chat',
        copy: 'Copy',
        model: 'Model:'
      };
    }
  };

  return inst;
}
