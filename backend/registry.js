import "jsr:@std/dotenv/load"; // needed for deno run; not req for smallweb or valtown

// Helper function to generate suggested config from server data
export function generateConfigFromServer(server) {
  const safeName = server.name.replace(/[^a-zA-Z0-9_]/g, '_');
  
  // Find the best remote URL (prefer streamable-http)
  let serverUrl = null;
  let headers = {};
  
  if (server.remotes && server.remotes.length > 0) {
    const streamableHttp = server.remotes.find(r => r.type === 'streamable-http');
    const remote = streamableHttp || server.remotes[0];
    serverUrl = remote.url;
    
    // Extract header requirements
    if (remote.headers) {
      remote.headers.forEach(header => {
        if (header.isSecret) {
          headers[header.name] = `() => Deno.env.get("${header.name.toUpperCase().replace(/-/g, '_')}")`;
        } else if (header.value) {
          headers[header.name] = header.value;
        }
      });
    }
  }

  if (!serverUrl) {
    return {
      note: "No remote URL found - this server may require local installation",
      packages: server.packages
    };
  }

  return {
    [safeName]: {
      type: "mcp",
      server_label: server.name,
      server_url: serverUrl,
      headers: Object.keys(headers).length > 0 ? headers : {},
      require_approval: "never",
      // Include original server info for reference
      _registry: {
        name: server.name,
        description: server.description,
        version: server.version,
        repository: server.repository?.url
      }
    }
  };
}

// Helper function to lookup tool from MCP registry
export async function lookupFromMcpRegistry(toolName) {
  try {
    // Search for the tool in the MCP registry
    const registryUrl = 'https://registry.modelcontextprotocol.io/v0/servers';
    const response = await fetch(registryUrl);
    
    if (!response.ok) {
      throw new Error(`Registry API error: ${response.status}`);
    }
    
    const data = await response.json();
    const servers = data.servers || [];
    
    // Find exact match or closest match
    let server = servers.find(s => s.name === toolName);
    
    // If no exact match, try fuzzy matching
    if (!server) {
      const normalizedSearch = toolName.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');
      server = servers.find(s => {
        const normalizedName = s.name.toLowerCase().replace(/[^a-zA-Z0-9]/g, '_');
        return normalizedName === normalizedSearch || 
               normalizedName.includes(normalizedSearch) ||
               normalizedSearch.includes(normalizedName);
      });
    }
    
    if (!server) {
      return null;
    }
    
    // Generate config from the found server
    const configMap = generateConfigFromServer(server);
    const configKey = Object.keys(configMap)[0];
    
    if (!configKey || configMap[configKey].note) {
      // Server requires local installation
      return null;
    }
    
    return configMap[configKey];
  } catch (error) {
    console.error('MCP registry lookup error:', error);
    return null;
  }
}
