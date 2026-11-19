type NeoRole = 'viewer' | 'member' | 'admin' | 'owner';

/** One inbound channel message, with memberRole already resolved by the channel integration. */
export interface ChannelMessage {
  id: string;
  /** `<platform>:<route>`; the platform prefix selects the delivery sink for replies. */
  channelId: string;
  botId: string;
  senderId: string;
  memberRole: NeoRole;
  text: string;
  mode?: 'observe' | 'act';
}

export interface ChannelReply {
  channelId: string;
  inReplyTo: string;
  text: string;
}

/** A platform integration (e.g. the Channels extension's WhatsApp slice). */
export interface ChannelPlatform {
  /** Engine callback from the platform's Hermes plugin; the platform authenticates it itself. */
  inbound(request: { authorization?: string; body: unknown }): Promise<{ status: number; body?: unknown }>;
  deliver(reply: ChannelReply): Promise<void>;
}

/**
 * Gateway-owned rendezvous between channel platforms and the Neo Inbox (the
 * superagent's `neo/channel` source). Either side can be enabled or disabled
 * in any order: the bus outlives both, so neither holds a stale reference.
 */
export class ChannelBus {
  private listener?: (message: ChannelMessage) => Promise<void>;
  private readonly platforms = new Map<string, ChannelPlatform>();
  /** Replies for channels with no attached platform (bounded). Read only by test hooks. */
  readonly replies: ChannelReply[] = [];

  /** ChannelSource for the Inbox. */
  subscribe(onMessage: (message: ChannelMessage) => Promise<void>): () => void {
    this.listener = onMessage;
    return () => { if (this.listener === onMessage) this.listener = undefined; };
  }

  get listening(): boolean { return !!this.listener; }

  /** Hand an inbound message to the Inbox. Throws when the Inbox is not running. */
  async emit(message: ChannelMessage): Promise<void> {
    if (!this.listener) throw new Error('Neo Inbox is not listening');
    await this.listener(message);
  }

  /** ChannelSource for the Inbox: route a report back to the platform named by channelId. */
  async reply(reply: ChannelReply): Promise<void> {
    const platform = this.platforms.get(reply.channelId.split(':', 1)[0]!);
    if (platform) { await platform.deliver(reply); return; }
    this.replies.push({ ...reply });
    if (this.replies.length > 100) this.replies.shift();
  }

  attach(id: string, platform: ChannelPlatform): () => void {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error('Invalid channel platform id');
    this.platforms.set(id, platform);
    return () => { if (this.platforms.get(id) === platform) this.platforms.delete(id); };
  }

  platform(id: string): ChannelPlatform | undefined { return this.platforms.get(id); }
}
