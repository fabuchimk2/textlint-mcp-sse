# textlint MCP Streamable HTTP対応の修正計画

## 現状分析

### 既存実装の詳細

textlintのMCP実装を実際に確認した結果：

**使用しているSDK**:
- `@modelcontextprotocol/sdk` version `^1.21.1`
- 公式のMCP TypeScript SDKを使用

**実装ファイル**:
- `packages/textlint/src/mcp/server.ts` - MCPサーバーの実装
  - `setupServer()`: `McpServer`インスタンスを作成し、4つのツール（lintFile, lintText, getLintFixedFileContent, getLintFixedTextContent）を登録
  - `connectStdioMcpServer()`: `StdioServerTransport`を使用してstdio経由で接続
- `packages/textlint/src/mcp/schemas.ts` - Zodスキーマ定義
- `packages/textlint/src/cli.ts` - CLIエントリポイント
  - `--mcp`フラグで`connectStdioMcpServer()`を呼び出す（80-96行目）

**既存のアーキテクチャの特徴**:
- トランスポート層は既にMCP SDKレベルで抽象化されている
- `McpServer`クラスは`StdioServerTransport`に依存していない
- サーバーのセットアップ（ツール登録）とトランスポート接続が分離されている

### 現在の制限事項

- stdio transportのみのため、ローカル環境でのプロセス間通信に限定される
- Webアプリケーションやリモート接続からの利用ができない
- HTTP/HTTPSベースのクライアントとの通信ができない

## Streamable HTTP対応の目的

### 重要な発見: SSEの非推奨化

調査の結果、MCPプロトコルの重要な変更を発見しました：

- **SSE transportは2024-11-05に非推奨**となりました
- **Streamable HTTP transport**に置き換えられました（MCP仕様 2025-03-26版）
- TypeScript SDK version 1.10.0+（2025年4月17日リリース）でサポート
- textlintが使用している`@modelcontextprotocol/sdk@^1.21.1`は対応済み

### Streamable HTTPの特徴

1. **HTTPベースの双方向通信**
   - クライアント→サーバー: HTTP POST
   - サーバー→クライアント: HTTP レスポンス（オプションでSSEストリーミング）

2. **セッション管理**
   - `Mcp-Session-Id`ヘッダーによるセッション識別
   - ステートレスモードとステートフルモードの両方をサポート

3. **セキュリティ**
   - DNS rebinding protection
   - 標準的なHTTP認証・認可メカニズムを利用可能

### メリット

1. **Webアプリケーション対応**: ブラウザベースのエディタやWebアプリケーションから利用可能
2. **リモートアクセス**: ネットワーク経由でのtextlintサービスの提供が可能
3. **柔軟な配信**: クラウド環境やコンテナ環境での配信が容易
4. **標準的なHTTP通信**: ファイアウォールやプロキシを通過しやすい
5. **スケーラビリティ**: ロードバランサーやリバースプロキシとの統合が容易

## 修正が必要な箇所

### 既存コードの分析結果

MCP SDKが既にトランスポート層を抽象化しているため、実装は非常にシンプルになります：

1. **変更不要**: `server.ts`の`setupServer()`関数
   - 既に`McpServer`を返しているので、そのまま再利用可能

2. **変更不要**: `schemas.ts`
   - データ構造の定義は変更なし

3. **新規作成**: HTTP/Expressサーバーの実装

4. **修正**: `cli.ts`でのトランスポート選択ロジック

### 実装方針の大幅な変更

**当初の計画**: トランスポート層を独自に抽象化し、独自のSSETransportクラスを実装
**修正後の計画**: MCP SDK提供の`StreamableHTTPServerTransport`を使用

これにより、実装の複雑さが大幅に削減されます。

## 実装の詳細

### 1. 新規ファイル: `packages/textlint/src/mcp/http-server.ts`

MCP SDK提供の`StreamableHTTPServerTransport`を使用したHTTPサーバー実装。

```typescript
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
    }

    // MCP Serverをセットアップ（ツール登録）
    // setupServer()は既存のコードをそのまま使用
    const mcpServer = await setupServer(options);

    if (options.debug) {
        httpDebug("MCP HTTP server initialized");
    }

    // ステートレスモード: 各リクエストごとに新しいトランスポートを作成
    app.post("/mcp", async (req: Request, res: Response) => {
        try {
            if (options.debug) {
                httpDebug("Received MCP request");
            }

            // 新しいトランスポートを作成
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // ステートレスモード
                enableJsonResponse: true
            });

            // レスポンスがクローズされたらトランスポートもクローズ
            res.on("close", () => {
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

    // ヘルスチェックエンドポイント
    app.get("/health", (req: Request, res: Response) => {
        res.json({
            status: "ok",
            service: "textlint-mcp",
            transport: "streamable-http"
        });
    });

    // サーバー起動
    return new Promise((resolve) => {
        app.listen(port, host, () => {
            console.log(`textlint MCP server listening on http://${host}:${port}/mcp`);
            if (options.debug) {
                httpDebug(`Server started on http://${host}:${port}`);
            }
            resolve();
        });
    });
};
```

### 2. `packages/textlint/src/cli.ts` の修正

CLIオプションを拡張して、Streamable HTTPモードを選択できるようにします。

**追加するオプション**:
```typescript
// options.tsに追加
{
    option: "mcp-http",
    type: "Boolean",
    default: false,
    description: "Start textlint as MCP server with Streamable HTTP transport"
},
{
    option: "mcp-port",
    type: "Number",
    default: 3000,
    description: "Port number for MCP HTTP server (used with --mcp-http)"
},
{
    option: "mcp-host",
    type: "String",
    default: "0.0.0.0",
    description: "Host address for MCP HTTP server (used with --mcp-http)"
},
{
    option: "mcp-cors",
    type: "Boolean",
    default: false,
    description: "Enable CORS for MCP HTTP server (used with --mcp-http)"
}
```

**cli.tsの修正**:
```typescript
// cli.ts内（80行目付近）
} else if (currentOptions.mcp) {
    // Map CLI options to MCP server options
    const mcpOptions: McpServerOptions = {
        configFilePath: currentOptions.config,
        node_modulesDir: currentOptions.rulesBaseDirectory,
        ignoreFilePath: currentOptions.ignorePath,
        quiet: currentOptions.quiet,
        debug: currentOptions.debug,
        cwd: process.cwd()
    };

    const mcpServer = await connectStdioMcpServer(mcpOptions);
    process.on("SIGINT", () => {
        mcpServer.close();
        process.exitCode = 0;
    });
    return 0;
} else if (currentOptions.mcpHttp) {
    // 新規追加: Streamable HTTP mode
    const { startHttpServer } = await import("./mcp/http-server.js");

    const httpOptions: HttpServerOptions = {
        configFilePath: currentOptions.config,
        node_modulesDir: currentOptions.rulesBaseDirectory,
        ignoreFilePath: currentOptions.ignorePath,
        quiet: currentOptions.quiet,
        debug: currentOptions.debug,
        cwd: process.cwd(),
        port: currentOptions.mcpPort,
        host: currentOptions.mcpHost,
        enableCors: currentOptions.mcpCors
    };

    await startHttpServer(httpOptions);

    // Graceful shutdown
    process.on("SIGINT", () => {
        console.log("\nShutting down MCP HTTP server...");
        process.exit(0);
    });

    // Keep the process running
    return new Promise(() => {});
}
```

### 3. `packages/textlint/src/options.ts` の修正

新しいCLIオプションを追加します。

```typescript
// 既存のoptions配列に追加
{
    option: "mcp-http",
    type: "Boolean",
    default: false,
    description: "Start textlint as MCP server with Streamable HTTP transport"
},
{
    option: "mcp-port",
    type: "Number",
    default: 3000,
    description: "Port number for MCP HTTP server (default: 3000)"
},
{
    option: "mcp-host",
    type: "String",
    default: "0.0.0.0",
    description: "Host address for MCP HTTP server (default: 0.0.0.0)"
},
{
    option: "mcp-cors",
    type: "Boolean",
    default: false,
    description: "Enable CORS for MCP HTTP server"
}
```

## 使用方法

### stdio mode（既存）

```bash
npx textlint --mcp
```

### Streamable HTTP mode（新規）

```bash
# デフォルト設定（ポート3000、全インターフェースでリッスン）
npx textlint --mcp-http

# ポート指定
npx textlint --mcp-http --mcp-port 8080

# ホスト指定
npx textlint --mcp-http --mcp-host localhost

# CORS有効化
npx textlint --mcp-http --mcp-cors

# 設定ファイルと組み合わせ
npx textlint --mcp-http --config .textlintrc.json --mcp-port 3000

# デバッグモード
DEBUG=textlint:mcp:* npx textlint --mcp-http --debug
```

### クライアント設定例

#### Claude Code (.claude/mcp.json)
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

#### HTTPクライアントからの利用例
```bash
# ヘルスチェック
curl http://localhost:3000/health

# lintFileツールの実行
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

## 実装ステップ

### Phase 1: 基本実装（最小限の機能）

1. **依存関係の追加**
   ```bash
   cd packages/textlint
   pnpm add express
   pnpm add -D @types/express
   ```

2. **http-server.tsの実装**
   - ステートレスモードのみ
   - 基本的なエンドポイント（/mcp, /health）

3. **options.tsとcli.tsの修正**
   - 新しいCLIオプションの追加
   - HTTPサーバー起動ロジックの追加

4. **動作確認**
   - ローカルでのHTTPサーバー起動テスト
   - curlでの基本的なリクエストテスト

### Phase 2: テストとドキュメント

5. **テストの実装**
   - HTTPサーバーの統合テスト
   - エンドポイントの動作テスト
   - エラーハンドリングのテスト

6. **ドキュメント更新**
   - `docs/mcp.md`の更新
   - Streamable HTTP transportの使用方法追加
   - クライアント設定例の追加
   - README.mdの更新

### Phase 3: 高度な機能（オプション）

7. **セッション管理の実装**（必要に応じて）
   - ステートフルモードのサポート
   - セッションIDの管理
   - タイムアウト処理

8. **セキュリティ強化**
   - 認証機能の追加（Bearer token等）
   - レート制限
   - DNS rebinding protection の有効化

9. **モニタリング**
   - ログ出力の充実
   - メトリクスの収集

## 依存関係の追加

`packages/textlint/package.json`に以下を追加：

```json
{
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21"
  }
}
```

**注**: `@modelcontextprotocol/sdk@^1.21.1`は既に存在するため、追加不要です。

## ディレクトリ構造

```
packages/textlint/src/
├── mcp/
│   ├── server.ts          # 既存（変更なし）
│   ├── schemas.ts         # 既存（変更なし）
│   └── http-server.ts     # 新規: Streamable HTTP実装
├── cli.ts                 # 修正: HTTPモード追加
└── options.ts             # 修正: 新規オプション追加
```

## テスト戦略

### ユニットテスト

- HTTPサーバーのセットアップテスト
- エンドポイントのルーティングテスト
- エラーハンドリングのテスト

### 統合テスト

```typescript
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";

describe("MCP HTTP Server", () => {
  it("should respond to health check", async () => {
    // テストの実装
  });

  it("should handle lintFile request", async () => {
    const response = await request(app)
      .post("/mcp")
      .send({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "lintFile",
          arguments: {
            filePaths: ["test.md"]
          }
        },
        id: 1
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("result");
  });
});
```

### E2Eテスト

- 実際のHTTPクライアントからのリクエスト
- stdio modeとHTTP modeの両方での動作確認
- 複数の同時リクエストの処理

## セキュリティ考慮事項

### 開発環境での使用

デフォルト設定はローカル開発向け：
- CORS無効
- 認証なし
- デバッグログ有効可能

### 本番環境での推奨設定

本番環境で使用する場合は以下を推奨：

1. **認証の実装**
   ```typescript
   app.use((req, res, next) => {
     const token = req.headers.authorization?.replace("Bearer ", "");
     if (!isValidToken(token)) {
       res.status(401).json({ error: "Unauthorized" });
       return;
     }
     next();
   });
   ```

2. **HTTPS化**
   - リバースプロキシ（nginx, Caddy等）でTLS終端
   - または、Expressにhttpsモジュールを統合

3. **レート制限**
   ```typescript
   import rateLimit from "express-rate-limit";

   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15分
     max: 100 // 100リクエスト/15分
   });

   app.use("/mcp", limiter);
   ```

4. **DNS rebinding protection**
   ```typescript
   const transport = new StreamableHTTPServerTransport({
     sessionIdGenerator: undefined,
     enableJsonResponse: true,
     dnsRebindingProtection: {
       enabled: true,
       allowedHosts: ["textlint.example.com"]
     }
   });
   ```

## 互換性の維持

- **既存のstdio mode**: 完全に維持（デフォルト動作）
- **既存のCLIオプション**: すべて互換性あり
- **既存のツール**: 変更なし（lintFile, lintText等）
- **設定ファイル**: 既存の.textlintrc等はそのまま使用可能

## パフォーマンス考慮事項

### ステートレス vs ステートフル

**ステートレスモード**（推奨）:
- メリット: シンプル、スケーラブル、メモリ効率的
- デメリット: リクエストごとにサーバーセットアップのオーバーヘッド（ただし軽微）

**ステートフルモード**（オプション）:
- メリット: セッション維持、リクエスト間での状態共有
- デメリット: メモリ使用量増加、セッション管理の複雑さ

現在の実装ではステートレスモードを採用していますが、必要に応じてステートフルモードも実装可能です。

### ベンチマーク目標

- 1リクエストあたりの処理時間: < 100ms（小規模ファイル）
- 同時接続数: 100+ リクエスト/秒
- メモリ使用量: ベースライン + 数MB（リクエストあたり）

## リスクと対策

### リスク

1. **下位互換性の破壊**: なし（既存のstdio modeは完全に維持）
2. **セキュリティ**: HTTPサーバーを公開することによるリスク
3. **パフォーマンス**: HTTPオーバーヘッド

### 対策

1. stdio modeとHTTP modeを完全に分離（既存コードの変更最小限）
2. 認証・認可機能の実装、CORS設定の適切な管理、デフォルトはローカルホストのみ
3. ベンチマークテストとプロファイリング、必要に応じてキャッシング実装

## マイグレーションパス

既存ユーザーへの影響なし：

1. **既存ユーザー**: `--mcp`で従来通りstdio modeを使用
2. **新規ユーザー**: 用途に応じてstdio/HTTPを選択
3. **段階的移行**: stdio → HTTPへの移行を任意のタイミングで実施可能

## 参考資料

### MCP仕様とSDK
- [Model Context Protocol Specification 2025-03-26](https://spec.modelcontextprotocol.io/)
- [@modelcontextprotocol/sdk - npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [Why MCP Deprecated SSE and Went with Streamable HTTP](https://blog.fka.dev/blog/2025-06-06-why-mcp-deprecated-sse-and-go-with-streamable-http/)

### 実装例
- [mcp-streamable-http-typescript-server](https://github.com/ferrants/mcp-streamable-http-typescript-server)
- [Deploy Remote MCP Servers with Streamable HTTP](https://www.koyeb.com/tutorials/deploy-remote-mcp-servers-to-koyeb-using-streamable-http-transport)

### 関連技術
- [Express.js Documentation](https://expressjs.com/)
- [Server-Sent Events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)

## まとめ

この修正計画では、textlintのMCP実装に**Streamable HTTP transport**対応を追加する方法を詳細に説明しました。

**主な発見と変更点**:

1. **SSEは非推奨**: MCP仕様でSSE transportは非推奨となり、Streamable HTTPに置き換えられました

2. **実装の簡素化**: MCP SDK（`@modelcontextprotocol/sdk@^1.21.1`）が既に`StreamableHTTPServerTransport`を提供しているため、独自のトランスポート実装は不要です

3. **既存コードの活用**: `setupServer()`関数は変更不要で、そのまま再利用できます

4. **最小限の変更**: 新しいHTTPサーバーファイル1つと、CLIオプションの追加のみで実装可能です

**実装の優位性**:

- 既存のstdio実装に一切影響なし
- シンプルで保守しやすいコード
- MCP公式SDKの機能をフル活用
- 段階的な導入が可能

実装は3つのフェーズに分けて進めることで、リスクを最小限に抑えながら確実に機能を追加できます。
