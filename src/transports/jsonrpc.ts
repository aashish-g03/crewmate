// src/transports/jsonrpc.ts

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NotificationHandler = (method: string, params: Record<string, unknown>) => void;

export type RequestHandler = (
  method: string,
  params: Record<string, unknown>
) => Promise<{ result?: unknown; error?: { code: number; message: string } }>;

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private writeFn: (data: string) => void;
  private defaultTimeoutMs: number;
  private notificationHandler: NotificationHandler | null = null;
  private requestHandler: RequestHandler | null = null;

  constructor(opts: {
    write: (data: string) => void;
    defaultTimeoutMs?: number;
  }) {
    this.writeFn = opts.write;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  private respond(id: number | string, payload: { result?: unknown; error?: { code: number; message: string } }): void {
    const resp: Record<string, unknown> = { jsonrpc: '2.0', id };
    if (payload.error) resp.error = payload.error;
    else resp.result = payload.result ?? null;
    this.writeFn(JSON.stringify(resp) + '\n');
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id as number)) {
        const p = this.pending.get(msg.id as number)!;
        this.pending.delete(msg.id as number);
        clearTimeout(p.timer);
        p.resolve(msg as unknown as JsonRpcResponse);
      } else if (msg.method !== undefined && msg.id === undefined && this.notificationHandler) {
        this.notificationHandler(msg.method as string, (msg.params ?? {}) as Record<string, unknown>);
      } else if (msg.method !== undefined && msg.id !== undefined && this.requestHandler) {
        const reqId = msg.id as number | string;
        const method = msg.method as string;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        void this.requestHandler(method, params).then(
          (result) => this.respond(reqId, result),
          (err) => this.respond(reqId, { error: { code: -32603, message: (err as Error).message } })
        );
      }
    }
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    this.writeFn(JSON.stringify(req) + '\n');

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = timeoutMs ?? this.defaultTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout: ${method} (id=${id}, ${timeout}ms)`));
      }, timeout);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.writeFn(JSON.stringify(msg) + '\n');
  }

  cancelAll(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
