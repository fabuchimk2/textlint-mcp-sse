import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { setupServer, type McpServerOptions } from "./server.js";
import debug from "debug";

const httpDebug = debug("textlint:mcp:http");

export interface HttpServerOptions extends McpServerOptions {
    port?: number;
    host?: string;
    enableCors?: boolean;
}

/**
 * Start textlint MCP server with Streamable HTTP transport
 *
 * This function creates an Express HTTP server that handles MCP requests
 * using the Streamable HTTP transport protocol (MCP spec 2025-03-26).
 *
 * @param options - HTTP server options including port, host, and MCP options
 * @returns Promise that resolves when the server is started
 *
 * @example
 * ```typescript
 * await startHttpServer({
 *   port: 3000,
 *   host: '0.0.0.0',
 *   enableCors: true,
 *   debug: true
 * });
 * ```
 */
export const startHttpServer = async (options: HttpServerOptions = {}): Promise<void> => {
    const app = express();
    const port = options.port ?? 3000;
    const host = options.host ?? "0.0.0.0";

    // Middleware
    app.use(express.json());

    // CORS設定（オプション）
    if (options.enableCors) {
        app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.header("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
            if (req.method === "OPTIONS") {
                res.sendStatus(200);
                return;
            }
            next();
        });

        if (options.debug) {
            httpDebug("CORS enabled for all origins");
        }
    }

    // MCP Serverをセットアップ（ツール登録）
    // setupServer()は既存のコードをそのまま使用
    const mcpServer = await setupServer(options);

    if (options.debug) {
        httpDebug("MCP HTTP server initialized");
    }

    /**
     * MCP endpoint - handles MCP JSON-RPC requests
     *
     * This endpoint uses stateless mode where each request gets a new transport.
     * This is simpler and more scalable than stateful mode.
     */
    app.post("/mcp", async (req: Request, res: Response) => {
        try {
            if (options.debug) {
                httpDebug("Received MCP request");
            }

            // 新しいトランスポートを作成（ステートレスモード）
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // ステートレスモード
                enableJsonResponse: true
            });

            // レスポンスがクローズされたらトランスポートもクローズ
            res.on("close", () => {
                if (options.debug) {
                    httpDebug("Connection closed, cleaning up transport");
                }
                transport.close();
            });

            // サーバーをトランスポートに接続
            await mcpServer.connect(transport);

            // リクエストを処理
            await transport.handleRequest(req, res, req.body);

            if (options.debug) {
                httpDebug("MCP request handled successfully");
            }
        } catch (error) {
            httpDebug("Error handling MCP request:", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: "Internal server error"
                    },
                    id: null
                });
            }
        }
    });

    /**
     * Health check endpoint
     *
     * Returns server status and transport information.
     * Useful for monitoring and container health checks.
     */
    app.get("/health", (req: Request, res: Response) => {
        res.json({
            status: "ok",
            service: "textlint-mcp",
            transport: "streamable-http",
            version: "1.0.0"
        });
    });

    // サーバー起動
    return new Promise((resolve) => {
        app.listen(port, host, () => {
            console.log(`textlint MCP server listening on http://${host}:${port}/mcp`);
            console.log(`Health check available at http://${host}:${port}/health`);
            if (options.debug) {
                httpDebug(`Server started on http://${host}:${port}`);
            }
            resolve();
        });
    });
};
