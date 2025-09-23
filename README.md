# MCP Navigator — AI-Powered MCP Tool Router for Groq

A smart, unified API for accessing Model Context Protocol (MCP) tools through Groq's Responses endpoint. Features AI-powered tool selection, dynamic MCP registry integration, and zero-configuration tool access.

## Features

- **🤖 AI Tool Selection** — Let AI automatically choose the best tools for your queries
- **🌐 Universal MCP Access** — Access any MCP tool from the official registry without configuration
- **📝 Dynamic Documentation** — Auto-generated examples based on actual available tools
- **🔑 Per-Tool API Keys** — Bring your own keys for each MCP tool
- **🚀 Browser-Friendly** — GET requests with query parameters for easy testing
- **⚡ Multiple Tool Support** — Execute multiple MCP tools in one request
- **🔧 Smart Registry** — Local tools + automatic fallback to public MCP registry

## Quick Start

1. **Install Deno:** https://deno.land/#installation

2. **Set environment variables:**
```bash
export GROQ_API_KEY="your_groq_api_key"
export PARALLEL_API_KEY="your_parallel_api_key"
```

3. **Start the server:**
```bash
deno task serve
```
This runs: `deno serve --allow-sys --allow-read --allow-import --allow-env --allow-write --allow-net --reload=https://esm.town ./main.js`

4. **Open http://localhost:8000** to see the API documentation

## Usage Examples

### 🤖 AI-Powered Tool Selection (Recommended)

Let AI automatically choose the best tools for your query:

```bash
# Browser-friendly: AI picks the right tools and executes them
GET /select?q=Plan a 3-day trip to Tokyo

# Generate curl commands for any query
GET /select?q=Find trending AI models&mode=curl

# Programmatic usage with custom API keys
curl -X POST "http://localhost:8000/select" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GROQ_API_KEY" \
  -d '{"query": "Build a travel itinerary for Paris", "mode": "execute"}'
```

### 🎯 Direct Tool Execution

When you know exactly which tools to use:

```bash
# Execute specific tools
GET /?tools=parallel_web_search&q=what's the weather in San Francisco

# Multiple tools coordination
GET /?tools=github,huggingface&q=research trending AI models and create an issue

# MCP Registry tool (zero configuration)
GET /?tools=garden.stanislav.svelte-llm/svelte-llm-mcp&q=what are svelte runes
```

### 📋 Tool Discovery

```bash
# List all available tools
GET /?mode=list

# Get detailed tool schemas
GET /?tools=parallel_web_search&mode=list

# Browse the MCP registry
GET /registry

# Search for specific tools
GET /registry?search=gmail
```

### Advanced: Per-Tool API Keys (POST)

For production use, you can provide custom API keys per tool using the POST endpoint:

```bash
# Execute with custom API keys for each tool
curl -X POST "http://localhost:8000/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_GROQ_API_KEY" \
  -d '{
    "tools": "parallel_web_search,github",
    "q": "research latest AI developments and create an issue",
    "toolHeaders": {
      "parallel_web_search": {
        "x-api-key": "USER_PROVIDED_PARALLEL_KEY"
      },
      "github": {
        "Authorization": "Bearer USER_PROVIDED_GITHUB_TOKEN"
      }
    }
  }'

# List tools with custom headers
curl -X POST "http://localhost:8000/" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "list",
    "tools": "parallel_web_search",
    "apiKey": "YOUR_GROQ_API_KEY",
    "toolHeaders": {
      "parallel_web_search": {
        "x-api-key": "USER_PROVIDED_PARALLEL_KEY"
      }
    }
  }'
```

**Key Features:**
- **Bring Your Own Keys**: Users can provide their own API keys for each MCP tool
- **Secure**: Keys are used per-request, not stored
- **Priority**: User-provided keys override environment variables
- **Flexible**: Mix environment keys with user keys as needed

## API Reference

### 🤖 AI Tool Selection

**`GET/POST /select`** — AI automatically chooses the best tools for your query

#### GET Parameters
| Parameter | Description | Default | Required |
|-----------|-------------|---------|----------|
| `q` or `query` | Your natural language query | - | Yes |
| `mode` | `execute` or `curl` | `execute` | No |
| `model` | Groq model to use | `openai/gpt-oss-120b` | No |

#### POST Body
```json
{
  "query": "Your natural language query",
  "mode": "execute",  // or "curl"
  "model": "openai/gpt-oss-120b"
}
```

**Examples:**
```bash
# Let AI pick tools and execute
GET /select?q=Plan a trip to Tokyo

# Generate curl command  
GET /select?q=Find trending AI models&mode=curl

# Programmatic usage
POST /select {"query": "Search for emails about project", "mode": "execute"}
```

### 🎯 Direct Tool Execution

**`GET/POST /`** — Execute specific tools when you know what you need

#### GET Parameters
| Parameter | Description | Default | Required |
|-----------|-------------|---------|----------|
| `tools` | Comma-separated tool names | - | For execute mode |
| `q` | Query/input for tools | - | For execute mode |
| `mode` | `execute` or `list` | `execute` | No |
| `model` | Groq model | `openai/gpt-oss-120b` | No |

#### POST Body (Enhanced)
    ```json
    {
  "tools": "tool1,tool2",
  "q": "Your query",
  "mode": "execute",
  "toolHeaders": {
    "tool1": {"x-api-key": "YOUR_KEY"}
  }
}
```

### 🔧 Other Endpoints

- **`GET /registry`** — Browse official MCP registry with search
- **`POST /api/tool/:toolName`** — Individual tool execution (supports MCP registry)
- **`GET /debug`** — Environment and configuration check
- **`POST /api/groq/responses`** — Direct Groq API wrapper

## 🌐 Universal MCP Access

One of the most powerful features is **zero-configuration access** to any MCP tool from the official registry:

```bash
# Use any MCP tool without setup - automatically discovered from registry
GET /?tools=garden.stanislav.svelte-llm/svelte-llm-mcp&q=what are svelte runes
GET /?tools=com.peek/mcp&q=plan a 3-day tokyo itinerary  
GET /?tools=ai.waystation/gmail&q=search for emails about the project

# Or let AI pick the perfect tool automatically  
GET /select?q=I need help with Svelte development
```

**How it works:**
1. **Local Registry First** — Checks your configured tools
2. **MCP Registry Fallback** — Automatically searches 300+ public MCP tools
3. **Smart Matching** — Finds tools by exact name or fuzzy matching
4. **Zero Config** — Works immediately without setup

## Tool Registry

Tools are registered in the `toolsRegistry` object in `main.js`. Each tool can include optional `_meta` for better documentation and examples:

```javascript
const toolsRegistry = {
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
  // Add more tools here...
};
```

### Adding New Tools

1. Add your tool configuration to `toolsRegistry`
2. Set required environment variables
3. Optionally add `_meta` for better documentation
4. The tool will automatically be available via the API with dynamic examples

Example:
```javascript
new_tool: {
  type: "mcp",
  server_label: "new_tool",
  server_url: "https://example.com/mcp/",
  headers: {
    "authorization": () => `Bearer ${Deno.env.get("NEW_TOOL_API_KEY")}`
  },
  require_approval: "never",
  _meta: {
    description: "Custom tool for specific operations",
    example_queries: [
      "primary example query",
      "secondary example query",
      "tertiary example query"
    ],
    use_cases: ["Use case 1", "Use case 2", "Use case 3"]
  }
}
```

### Dynamic Documentation

The API documentation at `/` is **completely dynamic** and generates examples based on:

1. **Tool metadata** (`_meta`) if provided
2. **Registry descriptions** from dynamically loaded MCP tools  
3. **Smart detection** based on tool names and server labels
4. **Fallback examples** for unknown tool types

This means:
- ✅ **No hardcoded examples** - everything reflects your actual tool registry
- ✅ **Automatic updates** - adding tools instantly updates documentation
- ✅ **Consistent behavior** - examples work out of the box
- ✅ **Smart defaults** - reasonable examples even without metadata

## Response Format

### Successful Tool Execution
    ```json
{
  "id": "resp_01k5shpe...",
  "object": "response",
  "status": "completed",
  "output": [
    {
      "type": "mcp_call",
      "server_label": "parallel_web_search",
      "name": "web_search_preview",
      "output": "..."
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [...]
    }
  ],
  "usage": {...}
}
```

### Tool Schema Response
  ```json
  {
  "mode": "list",
  "schemas": [
    {
      "toolName": "parallel_web_search",
      "server_label": "parallel_web_search",
      "tools": [
        {
          "name": "web_search_preview",
          "description": "Perform web searches...",
          "input_schema": {...}
        }
      ],
      "tool_count": 1
    }
  ]
}
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GROQ_API_KEY` | Groq API key for model access | Yes |
| `PARALLEL_API_KEY` | Parallel AI API key for web search | For parallel_web_search tool |
| `GITHUB_TOKEN` | GitHub token for GitHub MCP tool | For github tool |

## SDK Examples

### Using OpenAI SDK with Groq

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// Single tool example
const response = await client.responses.create({
  model: "openai/gpt-oss-120b",
  input: "What models are trending on Huggingface?",
  tools: [
    {
      type: "mcp",
      server_label: "Huggingface",
      server_url: "https://huggingface.co/mcp",
    }
  ]
});

console.log(response);
```

### Multiple MCP Servers

```javascript
const response = await client.responses.create({
  model: "openai/gpt-oss-120b",
  input: "Please create a new issue in my repository called 'build-with-groq/groq-code-cli' with the title 'Add MCP examples' and outline a few examples of MCP?",
  tools: [
    {
      type: "mcp",
      server_label: "GitHub",
      server_url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer <GITHUB_TOKEN>"
      }
    },
    {
      type: "mcp",
      server_label: "Huggingface",
      server_url: "https://huggingface.co/mcp",
    }
  ]
});

console.log(response);
```

### Advanced: Multiple Systems Coordination

```javascript
const response = await client.responses.create({
  model: "openai/gpt-oss-120b",
  input: "Research trending AI models and create a GitHub issue summarizing them",
  tools: [
    {
      type: "mcp",
      server_label: "GitHub",
      server_url: "https://api.githubcopilot.com/mcp/",
      headers: { "Authorization": "Bearer <GITHUB_TOKEN>" }
    },
    {
      type: "mcp",
      server_label: "Huggingface",
      server_url: "https://huggingface.co/mcp"
    },
    {
      type: "mcp",
      server_label: "parallel_web_search",
      server_url: "https://mcp.parallel.ai/v1beta/search_mcp/",
      headers: { "x-api-key": "<PARALLEL_API_KEY>" }
    }
  ]
});
```

## Architecture

### Core Components

- **🤖 AI Tool Selector** — GPT-oss-120b automatically chooses optimal tools
- **🌐 Universal Registry** — Local tools + dynamic MCP registry integration  
- **📝 Dynamic Documentation** — Auto-generated examples from tool metadata
- **🔑 Flexible Auth** — Per-tool API keys with environment fallback
- **⚡ Smart Router** — Context-aware endpoint handling

### Intelligent Behaviors

- **`/select?q=X`** → AI picks tools and executes
- **`/?tools=X&q=Y`** → Direct tool execution
- **`/?mode=list`** → Tool discovery and schemas
- **No parameters** → Dynamic API documentation
- **Unknown tools** → Automatic MCP registry lookup

## Error Handling

The API provides detailed error messages with helpful examples:

- **401 Unauthorized** — Missing or invalid API keys
- **404 Not Found** — Tool not found in registry
- **400 Bad Request** — Missing required parameters

## Development

### Project Structure
```
groq-mcp-nav/
├── main.js           # Main server and API logic
├── deno.json         # Deno configuration
├── README.md         # This file
└── ...
```

### Testing Tools

Multiple ways to test and explore:
- **`/`** → Interactive API documentation
- **`/select?q=your query`** → AI-powered tool selection  
- **`/?tools=tool_name&q=test`** → Direct tool execution
- **`/?mode=list`** → Explore available tools
- **`/registry`** → Browse 300+ public MCP tools
- **`/debug`** → Check configuration and API keys

## Requirements

- **Deno 1.40+**
- **Groq API Key** (get one at https://groq.com)
- **Tool-specific API Keys** (e.g., Parallel AI for web search)

## Notes

- **AI-Powered** — Uses GPT-oss-120b for intelligent tool selection
- **Universal Access** — Works with 300+ MCP tools from the official registry
- **Zero Config** — Most tools work immediately without setup
- **Production Ready** — Per-tool API keys and secure environment variables
- **Browser & API** — Designed for both interactive and programmatic usage

**Powered by Groq** — get your API key at https://groq.com
