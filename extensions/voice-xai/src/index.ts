import { defineExtension } from '@neometaharness/kernel';
import {
  voiceSynthesizeInput, voiceSynthesizeOutput, voiceTranscribeInput, voiceTranscribeOutput,
  type NeoVoiceService, type VoiceSynthesizeInput, type VoiceSynthesizeOutput,
  type VoiceTranscribeInput, type VoiceTranscribeOutput,
} from '@neometaharness/contracts';

interface VoiceSettings {
  apiKey?: string;
  baseUrl?: string;
}

// Inject `voiceHttpClient` for offline tests or alternative HTTP transports.
export interface VoiceHttpClient {
  request(url: string, init: RequestInit): Promise<Response>;
}

const defaultHttpClient: VoiceHttpClient = {
  request: (url, init) => fetch(url, init),
};

export class XaiVoiceService implements NeoVoiceService {
  readonly providerId = 'xai';
  private active = true;

  constructor(
    private readonly settings: VoiceSettings,
    private readonly http: VoiceHttpClient = defaultHttpClient,
  ) {}

  get configured(): boolean { return this.active && Boolean(this.settings.apiKey?.trim()); }
  dispose(): void { this.active = false; }

  private async send(path: string, body: BodyInit, contentType?: string): Promise<Response> {
    if (!this.active) throw new Error('xAI Voice extension is disabled');
    const key = this.settings.apiKey?.trim();
    if (!key) throw new Error('xAI Voice API key is not configured');
    const origin = new URL(this.settings.baseUrl || 'https://api.x.ai');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash) {
      throw new Error('Invalid xAI Voice API origin');
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
    if (contentType) headers['Content-Type'] = contentType;
    let response: Response;
    try {
      response = await this.http.request(new URL(path, origin.origin).toString(), {
        method: 'POST', headers, body, signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // External transport failures may embed the authorization header in an error.
      throw new Error('xAI Voice request failed');
    }
    if (!response.ok) throw new Error(`xAI Voice HTTP ${response.status}`);
    return response;
  }

  async transcribe(raw: VoiceTranscribeInput): Promise<VoiceTranscribeOutput> {
    const input = voiceTranscribeInput.parse(raw);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) {
      throw new Error('Invalid audio encoding');
    }
    const audio = Buffer.from(input.audioBase64, 'base64');
    if (audio.length > 8_000_000) throw new Error('Audio file is too large');
    const form = new FormData();
    form.set('model', 'grok-voice-transcribe-2.0');
    if (input.language) form.set('language', input.language);
    const extension = input.mimeType === 'audio/mpeg' ? 'mp3' : input.mimeType === 'audio/wav' ? 'wav' : 'audio';
    form.set('file', new Blob([new Uint8Array(audio)], { type: input.mimeType }), `audio.${extension}`);
    const response = await this.send('/v1/stt', form);
    return voiceTranscribeOutput.parse(await response.json());
  }

  async synthesize(raw: VoiceSynthesizeInput): Promise<VoiceSynthesizeOutput> {
    const input = voiceSynthesizeInput.parse(raw);
    const response = await this.send('/v1/tts', JSON.stringify({
      text: input.text, voice_id: input.voice ?? 'eve', language: input.language ?? 'en',
    }), 'application/json');
    const mimeType = response.headers.get('content-type')?.split(';', 1)[0] || 'audio/mpeg';
    if (mimeType === 'application/json') {
      const json: unknown = await response.json();
      if (typeof json !== 'object' || json === null || !('audio' in json) || typeof json.audio !== 'string') {
        throw new Error('xAI Voice returned invalid audio');
      }
      const contentType = 'content_type' in json && typeof json.content_type === 'string' ? json.content_type : 'audio/mpeg';
      return voiceSynthesizeOutput.parse({ audioBase64: json.audio, mimeType: contentType });
    }
    return voiceSynthesizeOutput.parse({
      audioBase64: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType,
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
    ctx.route('transcribe', ({ body }) => voice.transcribe(body as VoiceTranscribeInput));
    ctx.route('synthesize', ({ body }) => voice.synthesize(body as VoiceSynthesizeInput));
  },
});
