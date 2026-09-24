// TEST FIXTURE ONLY. A local HTTP server that speaks the OpenAI-compatible
// chat-completions protocol NVIDIA exposes, so automated tests can inject
// 429s, 5xx, timeouts, unknown models and bad credentials deterministically.
// It is never referenced from src/: the runtime only talks to NVIDIA_BASE_URL.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedCall {
  at: number;
  key: string;
  model: string;
  body: any;
}

export type Behaviour = (call: RecordedCall) =>
  | { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
  | { reply: string; delayMs?: number };

export class NimTestServer {
  calls: RecordedCall[] = [];
  behaviour: Behaviour = () => ({ reply: 'ok' });
  catalog: string[] = [];
  #server: http.Server | null = null;
  #sockets = new Set<import('node:net').Socket>();
  url = '';

  async start(): Promise<string> {
    this.#server = http.createServer((req, res) => this.#handle(req, res));
    this.#server.on('connection', (s) => {
      this.#sockets.add(s);
      s.on('close', () => this.#sockets.delete(s));
    });
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', () => r()));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/v1`;
    return this.url;
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
  }

  callsByKey(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.calls) out[c.key] = (out[c.key] ?? 0) + 1;
    return out;
  }

  #handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: this.catalog.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* keep empty */
      }
      const call: RecordedCall = { at: Date.now(), key, model: body.model, body };
      this.calls.push(call);
      const b = this.behaviour(call);
      if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
      if (res.destroyed) return;
      if ('reply' in b) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'cmpl-test',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: b.reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
      } else {
        res.writeHead(b.status, { 'content-type': 'application/json', ...(b.headers ?? {}) });
        res.end(JSON.stringify(b.body ?? { error: `status ${b.status}` }));
      }
    });
  }
}
