import { assertSafeProviderUrl, defineExtension } from '@neometaharness/kernel';
import {
  voiceSynthesizeInput, voiceSynthesizeOutput, voiceTranscribeInput, voiceTranscribeOutput,
  type NeoVoiceService, type VoiceSynthesizeInput, type VoiceSynthesizeOutput,
  type VoiceTranscribeInput, type VoiceTranscribeOutput,
} from '@neometaharness/contracts';

const MAX_AUDIO_BYTES = 8_000_000;
const MAX_TEXT_REQUEST_BYTES = 64_000;
const MAX_TRANSCRIPT_BYTES = 128_000;
const MAX_JSON_AUDIO_BYTES = 11_000_000;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_REQUESTS_PER_MINUTE = 12;

interface VoiceSettings {
  apiKey?: string;
  baseUrl?: string;
  allowPrivateNetwork?: boolean;
  requestsPerMinute?: number;
}

// Inject `voiceHttpClient` for offline tests or alternative HTTP transports.
export interface VoiceHttpClient {
  request(url: string, init: RequestInit): Promise<Response>;
}

const defaultHttpClient: VoiceHttpClient = {
  request: (url, init) => fetch(url, init),
};

async function readLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('xAI Voice response too large');
  if (!response.body) throw new Error('xAI Voice response has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error('xAI Voice response too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function mediaType(response: Response): string {
  return response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isAudioType(value: string): boolean {
  return /^audio\/[a-z0-9.+-]+$/i.test(value);
}

function parseProviderJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error('xAI Voice returned invalid JSON');
  }
}

export class XaiVoiceService implements NeoVoiceService {
  readonly providerId = 'xai';
  private active = true;
  private readonly rateBuckets = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly settings: VoiceSettings,
    private readonly http: VoiceHttpClient = defaultHttpClient,
  ) {}

  get configured(): boolean { return this.active && Boolean(this.settings.apiKey?.trim()); }
  dispose(): void { this.active = false; this.rateBuckets.clear(); }

  private enforceRateLimit(requesterId: string): void {
    const now = Date.now();
    const configured = this.settings.requestsPerMinute;
    const limit = Number.isInteger(configured) && configured! >= 1 && configured! <= 120
      ? configured! : DEFAULT_REQUESTS_PER_MINUTE;
    const identity = requesterId || 'internal';
    const bucket = this.rateBuckets.get(identity);
    if (bucket && now - bucket.startedAt < RATE_WINDOW_MS) {
      if (bucket.count >= limit) throw new Error('xAI Voice rate limit exceeded');
      bucket.count++;
    } else {
      this.rateBuckets.set(identity, { startedAt: now, count: 1 });
    }
    if (this.rateBuckets.size > 512) {
      for (const [id, entry] of this.rateBuckets) {
        if (now - entry.startedAt >= RATE_WINDOW_MS) this.rateBuckets.delete(id);
      }
    }
  }

  private async send(path: string, body: BodyInit, requestBytes: number, requesterId: string, contentType?: string): Promise<Response> {
    if (!this.active) throw new Error('xAI Voice extension is disabled');
    const key = this.settings.apiKey?.trim();
    if (!key) throw new Error('xAI Voice API key is not configured');
    if (requestBytes > (path === '/v1/stt' ? MAX_AUDIO_BYTES : MAX_TEXT_REQUEST_BYTES)) {
      throw new Error('xAI Voice request too large');
    }
    const origin = new URL(this.settings.baseUrl || 'https://api.x.ai');
    await assertSafeProviderUrl(origin, { allowPrivateNetwork: this.settings.allowPrivateNetwork });
    this.enforceRateLimit(requesterId);
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (contentType) headers['Content-Type'] = contentType;
    let response: Response;
    try {
      response = await this.http.request(new URL(path, origin.origin).toString(), {
        method: 'POST', headers, body, signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
    } catch {
      // A transport failure can embed request credentials in its original error.
      throw new Error('xAI Voice request failed');
    }
    if (!response.ok) throw new Error(`xAI Voice HTTP ${response.status}`);
    return response;
  }

  async transcribe(raw: VoiceTranscribeInput, requesterId = 'internal'): Promise<VoiceTranscribeOutput> {
    const input = voiceTranscribeInput.parse(raw);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) {
      throw new Error('Invalid audio encoding');
    }
    if (Math.floor(input.audioBase64.length * 3 / 4) > MAX_AUDIO_BYTES + 2) {
      throw new Error('Audio file is too large');
    }
    const audio = Buffer.from(input.audioBase64, 'base64');
    if (audio.length > MAX_AUDIO_BYTES) throw new Error('Audio file is too large');
    const form = new FormData();
    form.set('model', 'grok-voice-transcribe-2.0');
    if (input.language) form.set('language', input.language);
    const extension = input.mimeType === 'audio/mpeg' ? 'mp3' : input.mimeType === 'audio/wav' ? 'wav' : 'audio';
    form.set('file', new Blob([new Uint8Array(audio)], { type: input.mimeType }), `audio.${extension}`);
    const response = await this.send('/v1/stt', form, audio.length, requesterId);
    if (mediaType(response) !== 'application/json') throw new Error('xAI Voice returned invalid transcript type');
    return voiceTranscribeOutput.parse(parseProviderJson(await readLimited(response, MAX_TRANSCRIPT_BYTES)));
  }

  async synthesize(raw: VoiceSynthesizeInput, requesterId = 'internal'): Promise<VoiceSynthesizeOutput> {
    const input = voiceSynthesizeInput.parse(raw);
    const body = JSON.stringify({ text: input.text, voice_id: input.voice ?? 'eve', language: input.language ?? 'en' });
    const response = await this.send('/v1/tts', body, Buffer.byteLength(body), requesterId, 'application/json');
    const mimeType = mediaType(response);
    if (mimeType === 'application/json') {
      const json = parseProviderJson(await readLimited(response, MAX_JSON_AUDIO_BYTES));
      if (typeof json !== 'object' || json === null || !('audio' in json) || typeof json.audio !== 'string'
          || !('content_type' in json) || typeof json.content_type !== 'string'
          || !isAudioType(json.content_type)
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(json.audio)
          || Buffer.byteLength(json.audio, 'base64') > MAX_AUDIO_BYTES) {
        throw new Error('xAI Voice returned invalid audio');
      }
      return voiceSynthesizeOutput.parse({ audioBase64: json.audio, mimeType: json.content_type });
    }
    if (!isAudioType(mimeType)) throw new Error('xAI Voice returned invalid audio type');
    return voiceSynthesizeOutput.parse({
      audioBase64: (await readLimited(response, MAX_AUDIO_BYTES)).toString('base64'), mimeType,
    });
  }
}

export default defineExtension({
  activate(ctx) {
    // Kernel resolves secret settings from the workspace vault before activation.
    const settings = ctx.inject<VoiceSettings>('settings') ?? {};
    const http = ctx.inject<VoiceHttpClient>('voiceHttpClient') ?? defaultHttpClient;
    const voice = new XaiVoiceService(settings, http);
    ctx.provide('neo.voice', voice);
    ctx.effect(() => () => voice.dispose());
    ctx.health(() => ({ ok: true }));
    ctx.route('status', () => ({ providerId: 'xai', configured: voice.configured }));
    ctx.route('transcribe', ({ body }) => {
      const request = body as { input: VoiceTranscribeInput; requesterId: string };
      return request?.input ? voice.transcribe(request.input, request.requesterId) : voice.transcribe(body as VoiceTranscribeInput);
    });
    ctx.route('synthesize', ({ body }) => {
      const request = body as { input: VoiceSynthesizeInput; requesterId: string };
      return request?.input ? voice.synthesize(request.input, request.requesterId) : voice.synthesize(body as VoiceSynthesizeInput);
    });
  },
});