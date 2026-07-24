// cloud-asr.ts — OpenAI-compatible cloud speech-to-text provider.
//
// Alternative to the bundled whisper.cpp path for machines that can't run
// local inference (e.g. RK3588 handheld on Debian 11 / glibc 2.31) or users
// who want a stronger hosted model (Groq whisper-large-v3, SiliconFlow, …).
//
// Pure module: no electron imports, fetch is injectable so node:test can
// drive it without a network. The IPC layer (ipc/asr.ts) feeds it the same
// 16 kHz mono PCM16 WAV buffer that local whisper-cli consumes.

export const DEFAULT_CLOUD_ASR_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_CLOUD_ASR_MODEL = 'whisper-1';
export const CLOUD_ASR_TIMEOUT_MS = 30_000;

export interface CloudAsrConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// Minimal structural type so tests can stub fetch without DOM lib types.
export type CloudAsrFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: FormData;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/** Normalized, validated config. Throws when the apiKey is missing — the
 *  caller routes to cloud only when the user explicitly chose it, so a
 *  missing key must surface as an error, never a silent local fallback. */
export function resolveCloudAsrConfig(config: CloudAsrConfig): {
  baseUrl: string;
  apiKey: string;
  model: string;
} {
  const apiKey = config.apiKey?.trim() ?? '';
  if (!apiKey) {
    throw new Error('cloud ASR apiKey is not configured (Settings → 语音 → ASR 提供商)');
  }
  const baseUrl = (config.baseUrl?.trim() || DEFAULT_CLOUD_ASR_BASE_URL).replace(/\/+$/, '');
  const model = config.model?.trim() || DEFAULT_CLOUD_ASR_MODEL;
  return { baseUrl, apiKey, model };
}

export function cloudAsrEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
}

/** Build the multipart/form-data body: fields `file` (WAV) + `model`, per
 *  the OpenAI audio transcriptions API. Exported for tests. */
export function buildTranscriptionForm(wav: Uint8Array, model: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  return form;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Extract a human-readable message from an OpenAI-style error body
 *  (`{"error":{"message":"…"}}`), falling back to raw text. */
export function errorMessageFromBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const msg = parsed?.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // not JSON — fall through to raw body
  }
  const trimmed = body.trim();
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * POST a 16 kHz mono PCM16 WAV to `{baseUrl}/audio/transcriptions` and
 * return the transcript. Throws on non-2xx (message carries the HTTP
 * status), on timeout (30 s default), and on malformed responses. The API
 * key is only ever placed in the Authorization header — never logged.
 */
export async function transcribeCloud(
  wav: Uint8Array,
  config: CloudAsrConfig,
  opts: { fetchImpl?: CloudAsrFetch; timeoutMs?: number } = {},
): Promise<string> {
  const { baseUrl, apiKey, model } = resolveCloudAsrConfig(config);
  const timeoutMs = opts.timeoutMs ?? CLOUD_ASR_TIMEOUT_MS;
  const fetchImpl: CloudAsrFetch = opts.fetchImpl ?? (fetch as unknown as CloudAsrFetch);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Awaited<ReturnType<CloudAsrFetch>>;
  try {
    res = await fetchImpl(cloudAsrEndpoint(baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: buildTranscriptionForm(wav, model),
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(`cloud ASR request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`cloud ASR request failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = errorMessageFromBody(body);
    throw new Error(`cloud ASR request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('cloud ASR response was not valid JSON');
  }
  const text = (parsed as { text?: unknown })?.text;
  if (typeof text !== 'string') {
    throw new Error('cloud ASR response is missing the "text" field');
  }
  return text.trim();
}
