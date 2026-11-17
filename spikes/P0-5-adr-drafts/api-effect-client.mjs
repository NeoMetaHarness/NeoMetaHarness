import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import * as Socket from 'effect/socket/Socket';
import { RpcClient, RpcSerialization } from 'effect/rpc';
import { rpcGroup } from './api-contract-effect.mjs';
export async function consumeEffect(url, count) {
  const started=performance.now();
  const socket=Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const protocol=RpcClient.layerProtocolSocket().pipe(Layer.provide(socket),Layer.provide(RpcSerialization.layerJson));
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context=yield* Layer.build(protocol);
    const client=yield* RpcClient.make(rpcGroup).pipe(Effect.provide(context));
    let seen=0, final=0, firstDeltaMs=null;
    yield* client.subscribe({count}).pipe(
      Stream.runForEach(item=>Effect.sync(()=>{
        if(item.kind==='delta'){
          if(item.seq!==++seen || item.text!=='x')throw Error('Effect order/payload mismatch');
          if(seen===1)firstDeltaMs=performance.now()-started;
        } else if(item.kind==='done'){
          if(item.seq!==count || final++)throw Error('Effect done mismatch');
        } else throw Error('Unexpected Effect event');
      })),
      Effect.provide(context)
    );
    if(seen!==count || final!==1)throw Error('Effect stream incomplete '+seen+'/'+final);
    return {seen,done:final,firstDeltaMs};
  })));
}
