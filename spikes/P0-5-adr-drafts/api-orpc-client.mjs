import { WebSocket } from 'ws';
import { RPCLink } from '@orpc/client/websocket';
import { createORPCClient } from '@orpc/client';
import { contract } from './api-contract-orpc.mjs';
export async function consumeOrpc(url,count) {
  const started=performance.now();
  const websocket = new WebSocket(url);
  const client = createORPCClient(new RPCLink({websocket}));
  try {
    let seen=0; let final=0; let firstDeltaMs=null;
    for await (const item of await client.subscribe({count})) {
      if (item.kind === 'delta') {
        if (item.seq !== ++seen || item.text !== 'x') throw new Error('oRPC order/payload mismatch');
        if (seen===1) firstDeltaMs=performance.now()-started;
      } else if (item.kind === 'done') {
        if (item.seq !== count || final++) throw new Error('oRPC done mismatch');
      } else throw new Error('Unknown oRPC event');
    }
    if (seen !== count || final !== 1) throw new Error('oRPC missing deltas/done: '+seen+'/'+final);
    return {seen,done:final,firstDeltaMs};
  } finally {
    websocket.close();
  }
}
