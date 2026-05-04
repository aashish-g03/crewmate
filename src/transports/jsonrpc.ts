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

export class JsonRpcClient {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = '';
  private writeFn: (data: string) => void;
  private defaultTimeoutMs: number;

  constructor(opts: {
    write: (data: string) => void;
    defaultTimeoutMs?: number;
  }) {
    this.writeFn = opts.write;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 60_000;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
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
