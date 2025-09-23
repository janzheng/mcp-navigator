import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown

// MCP Tools Registry - Dynamic tool configurations
export const toolsRegistry = {
  parallel_web_search: {
    type: "mcp",
    server_label: "parallel_web_search",
    server_url: "https://mcp.parallel.ai/v1beta/search_mcp/",
    headers: {
      "x-api-key": () => Deno.env.get("PARALLEL_API_KEY")
    },
    require_approval: "never",
    // Optional metadata for better dynamic examples
    _meta: {
      description: "Web search with AI-optimized results",
      example_queries: [
        "what's the weather in San Francisco",
        "latest developments in AI safety research",
        "current news about climate change"
      ],
      use_cases: ["Current events", "Research", "Weather", "News"]
    }
  },
  github: {
    type: "mcp",
    server_label: "GitHub",
    server_url: "https://api.githubcopilot.com/mcp/",
    headers: {
      "Authorization": () => `Bearer ${Deno.env.get("GITHUB_TOKEN")}`
    },
    require_approval: "never",
    _meta: {
      description: "GitHub repository management and operations",
      example_queries: [
        "create an issue in my repo about adding MCP examples",
        "search for repositories related to AI",
        "create a new issue titled 'Add authentication'"
      ],
      use_cases: ["Create issues", "Manage repos", "Code search", "Pull requests"]
    }
  },
  huggingface: {
    type: "mcp",
    server_label: "Huggingface",
    server_url: "https://huggingface.co/mcp",
    headers: {},
    require_approval: "never",
    _meta: {
      description: "Hugging Face model discovery and information",
      example_queries: [
        "what are the trending AI models this week?",
        "find the most popular text-to-image models",
        "search for models related to natural language processing"
      ],
      use_cases: ["Model discovery", "Trending models", "Model info", "AI research"]
    }
  }
  // Add more MCP tools here as needed
};

// Helper function to resolve tool configuration with environment variables and user overrides
export function resolveToolConfig(toolConfig, userHeaders = {}) {
  const resolved = { ...toolConfig };
  
  // Remove metadata fields that shouldn't be sent to Groq
  delete resolved._meta;
  delete resolved._registry;
  
  // Resolve header functions to actual values
  if (resolved.headers) {
    const resolvedHeaders = {};
    for (const [key, value] of Object.entries(resolved.headers)) {
      // Check if user provided this header override
      if (userHeaders[key]) {
        resolvedHeaders[key] = userHeaders[key];
      } else if (typeof value === 'function') {
        resolvedHeaders[key] = value();
      } else {
        resolvedHeaders[key] = value;
      }
    }
    resolved.headers = resolvedHeaders;
  }
  
  // Add any additional user headers not in the original config
  if (userHeaders) {
    resolved.headers = { ...resolved.headers, ...userHeaders };
  }
  
  return resolved;
}

// Cache for discovered tool schemas to avoid repeated discovery calls
export const toolSchemaCache = new Map();
