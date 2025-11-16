# textlint MCP SSE対応の修正計画

## 現状分析

### 既存実装
textlintは現在、Model Context Protocol (MCP) サーバーとして以下の構成で実装されています：

- **トランスポート**: stdio (標準入出力) のみ
- **起動方法**: `npx textlint --mcp`
- **実装ファイル**:
  - `packages/textlint/src/mcp/server.ts` - MCPサーバーの実装
  - `packages/textlint/src/mcp/schemas.ts` - データ構造と型定義

### 制限事項
- stdio transportのみのため、ローカル環境でのプロセス間通信に限定される
- Webアプリケーションやリモート接続からの利用ができない
- HTTP/HTTPSベースのクライアントとの通信ができない

## SSE対応の目的

### メリット
1. **Webアプリケーション対応**: ブラウザベースのエディタやWebアプリケーションから利用可能
2. **リモートアクセス**: ネットワーク経由でのtextlintサービスの提供が可能
3. **柔軟な配信**: クラウド環境やコンテナ環境での配信が容易
4. **標準的なHTTP通信**: ファイアウォールやプロキシを通過しやすい

### SSE (Server-Sent Events) の特徴
- HTTPベースの一方向ストリーミング（サーバー→クライアント）
- クライアントからのリクエストはHTTP POSTで送信
- リアルタイム更新が必要なアプリケーションに適している
- WebSocketよりもシンプルな実装

## 技術的要件

### 1. トランスポート層の抽象化
現在の実装は恐らくstdioに直接依存しているため、トランスポート層を抽象化する必要があります。

```typescript
interface Transport {
  send(message: any): Promise<void>;
  receive(): AsyncIterator<any>;
  close(): Promise<void>;
}

class StdioTransport implements Transport { ... }
class SSETransport implements Transport { ... }
```

### 2. HTTPサーバーの実装
SSE用のHTTPサーバーを実装する必要があります。

**必要な機能**:
- HTTP POSTエンドポイント（クライアント→サーバー）
- SSEエンドポイント（サーバー→クライアント）
- CORS対応
- 認証・認可（オプション）

**候補ライブラリ**:
- `express` - 軽量で実績のあるWebフレームワーク
- `fastify` - 高速なWebフレームワーク
- Node.js標準の `http` モジュール

### 3. SSEプロトコルの実装
SSEの仕様に準拠した実装が必要です。

**SSEフォーマット**:
```
data: {"type":"message","content":"..."}\n\n
```

**実装要件**:
- Content-Type: `text/event-stream`
- Connection: `keep-alive`
- Cache-Control: `no-cache`

## 修正が必要な箇所

### 1. ディレクトリ構造の拡張

```
packages/textlint/src/mcp/
├── server.ts           # 既存（要修正）
├── schemas.ts          # 既存（変更なし or 軽微な修正）
├── transports/         # 新規ディレクトリ
│   ├── index.ts        # Transport interface定義
│   ├── stdio.ts        # Stdio transport実装
│   └── sse.ts          # SSE transport実装
└── http-server.ts      # 新規: HTTPサーバー実装
```

### 2. server.ts の修正

**変更内容**:
- トランスポートをコンストラクタで注入できるように変更
- stdio特有のコードをStdioTransportクラスに移動
- トランスポート非依存なコアロジックとして再構成

**修正例**:
```typescript
// Before
export class MCPServer {
  constructor(private options: MCPServerOptions) {
    // stdioに直接依存
  }
}

// After
export class MCPServer {
  constructor(
    private transport: Transport,
    private options: MCPServerOptions
  ) {
    // トランスポート非依存
  }
}
```

### 3. 新規ファイル: transports/index.ts

トランスポート層のインターフェース定義。

```typescript
export interface Transport {
  // メッセージの送信
  send(message: any): Promise<void>;

  // メッセージの受信（非同期イテレータ）
  receive(): AsyncIterator<any>;

  // 接続のクローズ
  close(): Promise<void>;

  // イベントリスナー
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
}

export abstract class BaseTransport implements Transport {
  // 共通実装
}
```

### 4. 新規ファイル: transports/stdio.ts

既存のstdio実装をクラスとして分離。

```typescript
import { BaseTransport } from './index';

export class StdioTransport extends BaseTransport {
  constructor() {
    super();
  }

  async send(message: any): Promise<void> {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  async *receive(): AsyncIterator<any> {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    for await (const line of rl) {
      yield JSON.parse(line);
    }
  }

  async close(): Promise<void> {
    // cleanup
  }
}
```

### 5. 新規ファイル: transports/sse.ts

SSEトランスポートの実装。

```typescript
import { BaseTransport } from './index';
import type { Request, Response } from 'express';

export class SSETransport extends BaseTransport {
  private messageQueue: any[] = [];
  private response?: Response;

  constructor(private req: Request, private res: Response) {
    super();
    this.setupSSE();
  }

  private setupSSE(): void {
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('Access-Control-Allow-Origin', '*');
    this.res.flushHeaders();
  }

  async send(message: any): Promise<void> {
    const data = JSON.stringify(message);
    this.res.write(`data: ${data}\n\n`);
  }

  async *receive(): AsyncIterator<any> {
    // メッセージキューから取得
    while (true) {
      if (this.messageQueue.length > 0) {
        yield this.messageQueue.shift();
      } else {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  // POSTリクエストからメッセージを追加
  addMessage(message: any): void {
    this.messageQueue.push(message);
  }

  async close(): Promise<void> {
    this.res.end();
  }
}
```

### 6. 新規ファイル: http-server.ts

HTTPサーバーの実装。

```typescript
import express from 'express';
import { MCPServer } from './server';
import { SSETransport } from './transports/sse';

export interface HTTPServerOptions {
  port: number;
  host?: string;
  cors?: boolean;
}

export class MCPHTTPServer {
  private app: express.Application;
  private sessions: Map<string, SSETransport> = new Map();

  constructor(private options: HTTPServerOptions) {
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    if (this.options.cors) {
      this.app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        next();
      });
    }
  }

  private setupRoutes(): void {
    // SSEエンドポイント（サーバー→クライアント）
    this.app.get('/sse', (req, res) => {
      const sessionId = req.query.sessionId as string;
      const transport = new SSETransport(req, res);
      this.sessions.set(sessionId, transport);

      const mcpServer = new MCPServer(transport, {});
      mcpServer.start();

      req.on('close', () => {
        this.sessions.delete(sessionId);
        transport.close();
      });
    });

    // メッセージ送信エンドポイント（クライアント→サーバー）
    this.app.post('/message', (req, res) => {
      const sessionId = req.body.sessionId;
      const message = req.body.message;

      const transport = this.sessions.get(sessionId);
      if (transport) {
        transport.addMessage(message);
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });

    // ヘルスチェック
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok' });
    });
  }

  async start(): Promise<void> {
    const { port, host = '0.0.0.0' } = this.options;

    return new Promise((resolve) => {
      this.app.listen(port, host, () => {
        console.log(`MCP HTTP Server listening on http://${host}:${port}`);
        resolve();
      });
    });
  }
}
```

### 7. CLIの拡張

textlintのCLI引数を拡張して、トランスポートモードを選択できるようにします。

**修正ファイル**: `packages/textlint/src/cli.ts` (または該当するCLIエントリポイント)

**新規オプション**:
```bash
# 従来のstdio mode
npx textlint --mcp

# SSE mode
npx textlint --mcp --transport sse --port 3000

# または簡潔に
npx textlint --mcp-sse --port 3000
```

**実装例**:
```typescript
// CLI引数パース部分
const args = parseArgs(process.argv);

if (args.mcp) {
  const transport = args.transport || 'stdio';

  if (transport === 'stdio') {
    const transport = new StdioTransport();
    const server = new MCPServer(transport, options);
    await server.start();
  } else if (transport === 'sse') {
    const httpServer = new MCPHTTPServer({
      port: args.port || 3000,
      host: args.host || '0.0.0.0',
      cors: args.cors !== false
    });
    await httpServer.start();
  }
}
```

## 実装ステップ

### Phase 1: 基盤整備（トランスポート層の抽象化）

1. **Transportインターフェースの定義**
   - `transports/index.ts` を作成
   - Transport interfaceとBaseTransportクラスを実装

2. **StdioTransportの実装**
   - `transports/stdio.ts` を作成
   - 既存のstdio処理をクラスに移行

3. **server.tsのリファクタリング**
   - トランスポートをコンストラクタインジェクションに変更
   - 既存機能が引き続き動作することを確認

4. **テストの実装**
   - StdioTransportのユニットテスト
   - 既存のE2Eテストが通ることを確認

### Phase 2: SSE実装

5. **HTTPサーバーの実装**
   - `http-server.ts` を作成
   - Express (またはFastify) のセットアップ
   - 基本的なルーティング実装

6. **SSETransportの実装**
   - `transports/sse.ts` を作成
   - SSEプロトコルの実装
   - メッセージキューの実装

7. **セッション管理の実装**
   - セッションIDの生成と管理
   - タイムアウト処理
   - 接続の監視とクリーンアップ

8. **テストの実装**
   - SSETransportのユニットテスト
   - HTTPサーバーの統合テスト
   - E2Eテスト

### Phase 3: CLI統合

9. **CLI引数の拡張**
   - `--transport` オプションの追加
   - `--port`, `--host`, `--cors` オプションの追加
   - ヘルプメッセージの更新

10. **設定ファイルのサポート** (オプション)
    - `.textlintrc` でのトランスポート設定
    - 環境変数からの設定読み込み

11. **ドキュメント更新**
    - README.mdの更新
    - docs/mcp.mdの更新
    - 使用例の追加

### Phase 4: 最適化と追加機能

12. **パフォーマンス最適化**
    - メッセージバッファリング
    - 圧縮の検討

13. **セキュリティ強化**
    - 認証機能の追加（Bearer token等）
    - レート制限
    - 入力検証の強化

14. **モニタリング**
    - ログ出力の充実
    - メトリクスの収集（接続数、処理時間等）

## 依存関係の追加

package.jsonに以下の依存関係を追加する必要があります：

```json
{
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.17",
    "supertest": "^6.3.3",
    "@types/supertest": "^2.0.12"
  }
}
```

## 設定例

### エディタ設定（SSE mode）

#### VS Code (.vscode/mcp.json)
```json
{
  "mcpServers": {
    "textlint-sse": {
      "type": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

#### Claude Code (.claude/mcp.json)
```json
{
  "mcpServers": {
    "textlint-sse": {
      "transport": "sse",
      "url": "http://localhost:3000",
      "endpoints": {
        "sse": "/sse",
        "message": "/message"
      }
    }
  }
}
```

## 互換性の維持

- 既存のstdio modeは引き続きサポート（デフォルト）
- `--mcp` フラグは従来通りstdio modeで動作
- 新しいSSE modeは明示的に `--transport sse` で指定

## テスト戦略

### ユニットテスト
- 各Transportクラスの単体テスト
- HTTPサーバーのルーティングテスト
- セッション管理のテスト

### 統合テスト
- stdio modeとSSE modeの両方でのE2Eテスト
- 実際のtextlintルールを使用したテスト
- エラーハンドリングのテスト

### パフォーマンステスト
- 大量のメッセージ送受信のテスト
- 複数の同時接続のテスト
- メモリリークのチェック

## リスクと対策

### リスク
1. **下位互換性の破壊**: 既存のstdio実装の変更による影響
2. **セキュリティ**: HTTPサーバーを公開することによるリスク
3. **パフォーマンス**: SSEのオーバーヘッド

### 対策
1. 徹底的なテストと段階的なリリース
2. 認証機能の実装、CORS設定の適切な管理
3. ベンチマークテストとプロファイリング

## 参考資料

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [Server-Sent Events (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [Express.js Documentation](https://expressjs.com/)

## まとめ

この修正計画では、textlintのMCP実装にSSE対応を追加するための包括的なアプローチを提示しました。トランスポート層を抽象化することで、既存のstdio実装を維持しながら、新しいSSE transportを追加できます。

実装は4つのフェーズに分けて進めることで、リスクを最小限に抑えながら段階的に機能を追加していくことができます。
