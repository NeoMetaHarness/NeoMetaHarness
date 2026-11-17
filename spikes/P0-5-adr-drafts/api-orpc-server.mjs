import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { RPCHandler } from '@orpc/server/ws';
import { implement } from '@orpc/server';
import { contract } from './api-contract-orpc.mjs';

const os = implement(contract);
const router = { subscribe: os.subscribe.handler(async function* ({ input }) {
  for (let i = 1; i <= input.count; i++) yield { kind:'delta', seq:i, text:'x' };
  yield {kind:'done',seq:input.count,text:''};
}) };
export async function withOrpcServer(consumer) {
  const http = createServer();
  const wss = new WebSocketServer({server:http});
  const handler = new RPCHandler(router);
  wss.on('connection', (ws)=>{void handler.upgrade(ws);});
  await new Promise((resolve,reject)=>{http.once('error',reject);http.listen(0,'127.0.0.1',resolve)});
  try {
    const address=http.address();
    return await consumer('ws://127.0.0.1:'+address.port);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise((resolve)=>wss.close(resolve));
    await new Promise((resolve)=>http.close(resolve));
  }
}
