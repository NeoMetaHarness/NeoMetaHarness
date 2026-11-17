import { Rpc, RpcGroup } from 'effect/rpc';
import * as Schema from 'effect/Schema';
export const Event = Schema.Struct({ kind: Schema.Literals(['delta', 'done']), seq: Schema.Number, text: Schema.String });
export const rpcGroup = RpcGroup.make(Rpc.make('subscribe', {
  payload: Schema.Struct({ count: Schema.Number }),
  success: Event,
  stream: true,
}));
