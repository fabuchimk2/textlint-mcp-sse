# textlint MCP Streamable HTTP Transport Implementation

This directory contains the implementation files for adding Streamable HTTP transport support to textlint's Model Context Protocol (MCP) server.

## Overview

This implementation adds HTTP-based transport to textlint's MCP server, enabling remote access and web-based clients to use textlint's linting capabilities. The implementation uses the official MCP SDK's `StreamableHTTPServerTransport`.

## Files

### New Files

#### `packages/textlint/src/mcp/http-server.ts`
New HTTP server implementation using Express and MCP SDK's StreamableHTTPServerTransport.

**Key features:**
- Stateless mode for simplicity and scalability
- `/mcp` endpoint for MCP JSON-RPC requests
- `/health` endpoint for health checks
- Optional CORS support
- Debug logging support

#### Modified Files

#### `packages/textlint/src/options.ts`
Added new CLI options for HTTP transport:
- `--mcp-http`: Enable HTTP transport mode
- `--mcp-port <number>`: Specify port (default: 3000)
- `--mcp-host <string>`: Specify host (default: 0.0.0.0)
- `--mcp-cors`: Enable CORS

#### `packages/textlint/src/cli.ts`
Added HTTP mode support:
- Detects `--mcp-http` flag
- Starts HTTP server instead of stdio server
- Handles graceful shutdown (SIGINT, SIGTERM)

#### `packages/textlint/package.json`
Added dependencies:
- `express`: ^4.18.2 (runtime)
- `@types/express`: ^4.17.21 (dev)

## Installation

To apply this implementation to textlint:

1. Copy the files to the corresponding locations in the textlint repository:
   ```bash
   # New file
   cp implementation/packages/textlint/src/mcp/http-server.ts \
      <textlint-repo>/packages/textlint/src/mcp/http-server.ts

   # Modified files
   cp implementation/packages/textlint/src/options.ts \
      <textlint-repo>/packages/textlint/src/options.ts

   cp implementation/packages/textlint/src/cli.ts \
      <textlint-repo>/packages/textlint/src/cli.ts
   ```

2. Install new dependencies:
   ```bash
   cd <textlint-repo>/packages/textlint
   pnpm add express
   pnpm add -D @types/express
   ```

3. Build textlint:
   ```bash
   cd <textlint-repo>
   pnpm run build
   ```

## Usage

### stdio mode (existing, unchanged)

```bash
npx textlint --mcp
```

### Streamable HTTP mode (new)

```bash
# Start with default settings (port 3000, all interfaces)
npx textlint --mcp-http

# Specify port
npx textlint --mcp-http --mcp-port 8080

# Specify host (localhost only)
npx textlint --mcp-http --mcp-host localhost

# Enable CORS
npx textlint --mcp-http --mcp-cors

# With textlint configuration
npx textlint --mcp-http --config .textlintrc.json --mcp-port 3000

# Debug mode
DEBUG=textlint:mcp:* npx textlint --mcp-http --debug
```

## Client Configuration

### Claude Code

Add to `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "textlint": {
      "transport": "streamable-http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### HTTP Client Examples

#### Health check
```bash
curl http://localhost:3000/health
```

#### Lint files
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "lintFile",
      "arguments": {
        "filePaths": ["README.md"]
      }
    },
    "id": 1
  }'
```

#### Lint text
```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "lintText",
      "arguments": {
        "text": "This is a sample text.",
        "stdinFilename": "sample.md"
      }
    },
    "id": 1
  }'
```

## Architecture

### Transport Layer

The implementation uses MCP SDK's built-in transport abstraction:

```
┌─────────────────────────────────────┐
│         textlint CLI                │
├─────────────────────────────────────┤
│  --mcp        │  --mcp-http         │
├───────────────┼─────────────────────┤
│ StdioServer   │  Express HTTP       │
│ Transport     │  + StreamableHTTP   │
│               │    ServerTransport  │
├───────────────┴─────────────────────┤
│      McpServer (setupServer)        │
│  - lintFile                         │
│  - lintText                         │
│  - getLintFixedFileContent          │
│  - getLintFixedTextContent          │
└─────────────────────────────────────┘
```

### Stateless Mode

The implementation uses stateless mode where each HTTP request gets a new transport instance:

**Benefits:**
- Simple implementation
- No session management complexity
- Easy to scale horizontally
- Lower memory footprint

**Trade-offs:**
- No state sharing between requests
- Slightly higher overhead per request (minimal)

## Security Considerations

### Development Mode (default)

The default configuration is designed for local development:
- No authentication
- CORS disabled by default
- Listens on all interfaces (0.0.0.0)

### Production Recommendations

For production use, consider:

1. **Authentication**: Add authentication middleware
2. **HTTPS**: Use reverse proxy (nginx, Caddy) for TLS
3. **Host binding**: Use `--mcp-host localhost` to restrict access
4. **Rate limiting**: Implement rate limiting
5. **Firewall**: Use firewall rules to restrict access

Example with authentication:
```typescript
// Add to http-server.ts
app.use((req, res, next) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!isValidToken(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});
```

## Testing

### Manual Testing

1. Start the server:
   ```bash
   npx textlint --mcp-http --debug
   ```

2. Test health endpoint:
   ```bash
   curl http://localhost:3000/health
   ```

3. Test MCP endpoint:
   ```bash
   curl -X POST http://localhost:3000/mcp \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
   ```

### Integration Testing

Add to textlint's test suite:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHttpServer } from "../src/mcp/http-server.js";

describe("MCP HTTP Server", () => {
  let serverPromise: Promise<void>;

  beforeAll(async () => {
    serverPromise = startHttpServer({ port: 13000 });
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  it("should respond to health check", async () => {
    const response = await fetch("http://localhost:13000/health");
    const data = await response.json();
    expect(data.status).toBe("ok");
  });

  // Add more tests...
});
```

## Performance

### Expected Performance

- **Startup time**: < 1 second
- **Request latency**: < 100ms for small files
- **Throughput**: 100+ requests/second
- **Memory**: Base + ~5MB per concurrent request

### Optimization Tips

1. Use `--mcp-host localhost` if only local access needed
2. Run behind reverse proxy for production
3. Use HTTP/2 for better performance
4. Enable gzip compression in reverse proxy

## Compatibility

### Backward Compatibility

- ✅ Existing stdio mode unchanged
- ✅ All existing CLI options work
- ✅ All existing tools (lintFile, lintText, etc.) work
- ✅ Configuration files (.textlintrc) work as before

### Requirements

- Node.js: >=20.0.0
- textlint: >=15.3.0
- @modelcontextprotocol/sdk: ^1.21.1

## References

- [MCP Specification 2025-03-26](https://spec.modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Why MCP Deprecated SSE](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)
- [textlint Documentation](https://textlint.github.io/)

## License

MIT (same as textlint)
