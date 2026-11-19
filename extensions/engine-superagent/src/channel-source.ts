type NeoRole = 'viewer' | 'member' | 'admin' | 'owner';

export interface ChannelMessage {
  id: string;
  channelId: string;
  botId: string;
  senderId: string;
  memberRole: NeoRole;
  text: string;
  mode?: 'observe' | 'act';
}

export interface ChannelReply {
  /** Durable notifications require an attached transport, not the test-only reply sink. */
  requireDelivery?: boolean;
  channelId: string;
  inReplyTo: string;
  text: string;
}

/** A channel integration must resolve memberRole from authenticated membership before emitting. */
export interface ChannelSource {
  subscribe(onMessage: (message: ChannelMessage) => Promise<void>): () => void;
  reply(message: ChannelReply): Promise<void>;
}

/** Used only by the isolated gateway test until the Channels extension exposes ChannelSource. */
export class FakeChannelSource implements ChannelSource {
  readonly replies: ChannelReply[] = [];
  private listener?: (message: ChannelMessage) => Promise<void>;

  subscribe(onMessage: (message: ChannelMessage) => Promise<void>): () => void {
    this.listener = onMessage;
    return () => { this.listener = undefined; };
  }

  async emit(message: ChannelMessage): Promise<void> {
    if (!this.listener) throw new Error('Channel source is disabled');
    await this.listener(message);
  }

  async reply(message: ChannelReply): Promise<void> { this.replies.push({ ...message }); }
}
