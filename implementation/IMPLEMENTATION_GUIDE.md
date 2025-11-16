# Implementation Guide: Streamable HTTP Transport for textlint MCP

## Quick Summary

This implementation adds HTTP-based transport to textlint's MCP server with minimal changes:

- **1 new file**: `http-server.ts` (~140 lines)
- **2 modified files**: `options.ts`, `cli.ts`
- **2 new dependencies**: `express`, `@types/express`
- **100% backward compatible**: Existing stdio mode unchanged

## Change Summary

### 1. New File: `http-server.ts`

**Location**: `packages/textlint/src/mcp/http-server.ts`

**Purpose**: HTTP server implementation using Express and StreamableHTTPServerTransport

**Key Points**:
- Uses MCP SDK's built-in `StreamableHTTPServerTransport`
- Stateless mode (no session management)
- Two endpoints: `/mcp` (MCP requests) and `/health` (monitoring)
- Optional CORS support

**Lines of Code**: ~140 lines

### 2. Modified: `options.ts`

**Location**: `packages/textlint/src/options.ts`

**Changes**:
1. Added to `CliOptions` type:
   ```typescript
   mcpHttp: boolean;
   mcpPort: number;
   mcpHost: string;
   mcpCors: boolean;
   ```

2. Added new options section "Model Context Protocol (MCP)":
   - Reorganized existing `--mcp` option
   - Added `--mcp-http`, `--mcp-port`, `--mcp-host`, `--mcp-cors`

**Lines Changed**: ~50 lines added/modified

### 3. Modified: `cli.ts`

**Location**: `packages/textlint/src/cli.ts`

**Changes**:
1. Added new conditional branch after `--mcp` handling:
   ```typescript
   } else if (currentOptions.mcpHttp) {
       // Import and start HTTP server
       const { startHttpServer } = await import("./mcp/http-server.js");
       await startHttpServer(httpOptions);
       // Handle graceful shutdown
   }
   ```

2. Added SIGTERM handler for graceful shutdown

**Lines Changed**: ~30 lines added

### 4. Modified: `package.json`

**Location**: `packages/textlint/package.json`

**Changes**:
1. Added to `dependencies`:
   ```json
   "express": "^4.18.2"
   ```

2. Added to `devDependencies`:
   ```json
   "@types/express": "^4.17.21"
   ```

**Lines Changed**: 2 lines added

## Implementation Steps

### Step 1: Add Dependencies

```bash
cd packages/textlint
pnpm add express
pnpm add -D @types/express
```

### Step 2: Create http-server.ts

Copy `implementation/packages/textlint/src/mcp/http-server.ts` to the textlint repository.

### Step 3: Update options.ts

Replace the existing file with `implementation/packages/textlint/src/options.ts` or manually apply the changes:

1. Update `CliOptions` type
2. Add new options under "Model Context Protocol (MCP)" heading

### Step 4: Update cli.ts

Update the existing file with changes from `implementation/packages/textlint/src/cli.ts`:

1. Add the `mcpHttp` conditional branch after the `mcp` branch
2. Add SIGTERM handler

### Step 5: Build and Test

```bash
# Build
pnpm run build

# Test stdio mode (should work as before)
npx textlint --mcp

# Test HTTP mode (new)
npx textlint --mcp-http --debug
```

### Step 6: Verify

```bash
# In another terminal, test the endpoints
curl http://localhost:3000/health
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Design Decisions

### Why Streamable HTTP instead of SSE?

**Reason**: SSE transport was deprecated in MCP spec 2024-11-05 and replaced by Streamable HTTP (spec 2025-03-26).

**Benefits**:
- Official MCP SDK support
- Better compatibility with modern infrastructure
- Simpler implementation
- HTTP/2 friendly

### Why Stateless Mode?

**Reason**: Simplicity and scalability

**Benefits**:
- No session management complexity
- Easy horizontal scaling
- Lower memory footprint
- Each request is independent

**Trade-offs**:
- Minimal per-request overhead (creating new transport)
- No state sharing between requests (not needed for textlint use case)

### Why Express?

**Reason**: Industry standard, well-tested, minimal overhead

**Alternatives considered**:
- Fastify: Faster but adds complexity
- Node.js http module: Too low-level
- Other frameworks: Less popular, more dependencies

### Why Separate --mcp-http Flag?

**Reason**: Clear separation of concerns and backward compatibility

**Benefits**:
- Existing users unaffected
- Clear intent in command line
- Easy to document and support
- Can run both modes if needed (different terminals)

## Testing Strategy

### Unit Tests

Test the HTTP server setup:

```typescript
describe("startHttpServer", () => {
  it("should start server on specified port", async () => {
    // Test implementation
  });

  it("should handle CORS when enabled", async () => {
    // Test implementation
  });
});
```

### Integration Tests

Test MCP protocol over HTTP:

```typescript
describe("MCP HTTP Integration", () => {
  it("should handle tools/list request", async () => {
    // Start server, make request, verify response
  });

  it("should handle lintFile request", async () => {
    // Test actual linting over HTTP
  });
});
```

### E2E Tests

Test with real MCP clients:

1. Configure Claude Code to use HTTP transport
2. Run actual linting commands
3. Verify results match stdio mode

## Security Checklist

### Development (Default)

- [ ] Server starts successfully
- [ ] Health endpoint accessible
- [ ] MCP endpoint accepts requests
- [ ] Debug logging works
- [ ] CORS can be enabled

### Production

- [ ] Authentication implemented (if needed)
- [ ] HTTPS enabled (via reverse proxy)
- [ ] Host restricted (--mcp-host localhost)
- [ ] Rate limiting configured
- [ ] Firewall rules in place
- [ ] Monitoring configured

## Troubleshooting

### Server won't start

**Check**:
1. Port already in use: `lsof -i :3000`
2. Permissions: Can bind to the port?
3. Dependencies installed: `pnpm install`

**Solution**:
```bash
# Use different port
npx textlint --mcp-http --mcp-port 3001
```

### CORS errors

**Check**:
1. CORS enabled: `--mcp-cors`
2. Client sending correct headers

**Solution**:
```bash
npx textlint --mcp-http --mcp-cors
```

### Connection refused

**Check**:
1. Server running
2. Correct host/port in client config
3. Firewall not blocking

**Solution**:
```bash
# Verify server is listening
curl http://localhost:3000/health
```

## Performance Tuning

### For High Load

1. **Increase connection limits**:
   ```typescript
   // In http-server.ts
   app.listen(port, host, () => {
     server.maxConnections = 1000;
   });
   ```

2. **Use clustering**:
   ```bash
   # Run multiple instances behind load balancer
   pm2 start "npx textlint --mcp-http --mcp-port 3000" -i 4
   ```

3. **Add caching**:
   - Cache lint results for unchanged files
   - Use textlint's built-in cache: `--cache`

### For Low Latency

1. **Bind to localhost only**:
   ```bash
   npx textlint --mcp-http --mcp-host localhost
   ```

2. **Use HTTP/2**:
   - Configure reverse proxy for HTTP/2

3. **Enable compression**:
   - Configure in reverse proxy

## Migration from stdio to HTTP

### For Local Development

**Before**:
```json
{
  "mcpServers": {
    "textlint": {
      "command": "npx",
      "args": ["textlint", "--mcp"]
    }
  }
}
```

**After**:
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

**Steps**:
1. Start HTTP server: `npx textlint --mcp-http`
2. Update client config
3. Test

### For Remote/Cloud Deployment

**Deployment**:
```bash
# Example with systemd
cat > /etc/systemd/system/textlint-mcp.service <<EOF
[Unit]
Description=textlint MCP Server
After=network.target

[Service]
Type=simple
User=textlint
WorkingDir=/opt/textlint
ExecStart=/usr/bin/npx textlint --mcp-http --mcp-port 3000 --config /etc/textlint/.textlintrc
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable textlint-mcp
sudo systemctl start textlint-mcp
```

**Client Config**:
```json
{
  "mcpServers": {
    "textlint": {
      "transport": "streamable-http",
      "url": "https://textlint.example.com/mcp"
    }
  }
}
```

## Future Enhancements

### Phase 2 (Optional)

1. **Stateful Mode**:
   - Add session management
   - Track state between requests
   - Session timeout handling

2. **WebSocket Support**:
   - Add WebSocket endpoint for real-time updates
   - Useful for interactive editors

3. **Metrics**:
   - Request count
   - Average response time
   - Error rate
   - Active connections

### Phase 3 (Advanced)

1. **Distributed Deployment**:
   - Load balancing
   - Horizontal scaling
   - Session affinity

2. **Advanced Security**:
   - OAuth/OIDC integration
   - API key management
   - Request signing

## Contributing

When submitting PR to textlint:

1. Include all modified files
2. Update CHANGELOG.md
3. Add tests
4. Update documentation
5. Follow existing code style

## Support

- Issues: https://github.com/textlint/textlint/issues
- Discussions: https://github.com/textlint/textlint/discussions
- MCP Spec: https://spec.modelcontextprotocol.io/
