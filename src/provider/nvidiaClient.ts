// Thin HTTP client for NVIDIA's OpenAI-compatible inference API. It performs
// exactly one request per call using a key the Key Manager leased; it never
// chooses keys itself and never lets the secret leave this function.
import { redactString } from '../security/redact.ts';
import type { SecretVault, LeaseOutcomeStatus } from './keyPool.ts';
import type { ModelSpec } from './modelRegistry.ts';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
}

export interface ChatSuccess {
  ok: true;
  content: string;
  toolCalls: unknown[] | null;
  finishReason: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  httpStatus: number;
  latencyMs: number;
}

export interface ChatFailure {
  ok: false;
  status: Exclude<LeaseOutcomeStatus, 'ok'>;
  httpStatus: number | null;
  retryAfterMs: number | null;
  message: string;
  latencyMs: number;
}

export type ChatResult = ChatSuccess | ChatFailure;

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

const MODEL_MISSING = /(model|function)[^.]{0,60}(not found|does not exist|not available|unknown|is not supported)|no such model|Function id .* not found/i;

export function classifyHttpFailure(status: number, body: string): ChatFailure['status'] {
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'auth_error';
  if (status === 404 || ((status === 400 || status === 422 || status === 403) && MODEL_MISSING.test(body))) return 'model_unavailable';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server_error';
  if (status === 403) return 'auth_error';
  return 'client_error';
}

export class NvidiaClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  #vault: SecretVault;
  #fetch: typeof fetch;

  constructor(opts: { baseUrl: string; timeoutMs: number; vault: SecretVault; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.timeoutMs = opts.timeoutMs;
    this.#vault = opts.vault;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  endpointFor(model: ModelSpec): string {
    return model.endpoint ?? `${this.baseUrl}/chat/completions`;
  }

  async chat(keyId: string, model: ModelSpec, req: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const started = Date.now();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const messages = model.system_prefix ? applySystemPrefix(req.messages, model.system_prefix) : req.messages;
    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      temperature: req.temperature ?? model.default_params.temperature ?? 0.5,
      top_p: req.top_p ?? model.default_params.top_p ?? 0.95,
      max_tokens: Math.min(req.max_tokens ?? model.max_output_tokens, model.max_output_tokens),
      stream: false,
    };
    if (req.tools && model.tool_calling) {
      body.tools = req.tools;
      if (req.tool_choice) body.tool_choice = req.tool_choice;
    }
    if (req.response_format && model.json_mode) body.response_format = req.response_format;

    let res: Response;
    try {
      res = await this.#fetch(this.endpointFor(model), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#vault.reveal(keyId)}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      const latencyMs = Date.now() - started;
      if (signal?.aborted) return { ok: false, status: 'cancelled', httpStatus: null, retryAfterMs: null, message: 'request cancelled', latencyMs };
      const isTimeout = timeout.aborted || (err as Error)?.name === 'TimeoutError';
      return {
        ok: false,
        status: isTimeout ? 'timeout' : 'network_error',
        httpStatus: null,
        retryAfterMs: null,
        message: redactString(isTimeout ? `NVIDIA request timed out after ${this.timeoutMs}ms` : `network error: ${(err as Error)?.message ?? err}`),
        latencyMs,
      };
    }

    const text = await res.text().catch(() => '');
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        status: classifyHttpFailure(res.status, text),
        httpStatus: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
        message: redactString(`HTTP ${res.status}: ${text.slice(0, 400)}`),
        latencyMs,
      };
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: 'server_error', httpStatus: res.status, retryAfterMs: null, message: 'provider returned non-JSON body', latencyMs };
    }
    const choice = json?.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : null;
    if (!content && !toolCalls) {
      return { ok: false, status: 'server_error', httpStatus: res.status, retryAfterMs: null, message: 'provider returned an empty completion', latencyMs };
    }
    return {
      ok: true,
      content: stripThinking(content),
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: json?.usage ?? null,
      httpStatus: res.status,
      latencyMs,
    };
  }

  /** Lists models visible to a key. Used for registry discovery (itself leased through the Key Manager). */
  async listModels(keyId: string): Promise<{ ok: true; ids: string[] } | { ok: false; status: ChatFailure['status']; httpStatus: number | null; message: string }> {
    try {
      const res = await this.#fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.#vault.reveal(keyId)}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 30_000)),
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, status: classifyHttpFailure(res.status, text), httpStatus: res.status, message: redactString(`HTTP ${res.status}`) };
      const json = JSON.parse(text);
      return { ok: true, ids: (json?.data ?? []).map((m: any) => String(m.id)) };
    } catch (err) {
      return { ok: false, status: 'network_error', httpStatus: null, message: redactString(String((err as Error)?.message ?? err)) };
    }
  }
}

function applySystemPrefix(messages: ChatMessage[], prefix: string): ChatMessage[] {
  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string') {
    return [{ ...first, content: `${prefix}\n${first.content}` }, ...rest];
  }
  return [{ role: 'system', content: prefix }, ...messages];
}

/** Some reasoning models inline <think> blocks; agents only ever see the final answer. */
export function stripThinking(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
