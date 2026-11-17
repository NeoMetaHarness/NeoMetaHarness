import * as Effect from 'effect/Effect';
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { HttpRouter, HttpServer } from 'effect/http';
import * as NodeHttp from 'node:http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { RpcServer, RpcSerialization } from 'effect/rpc';
import { rpcGroup } from './api-contract-effect.mjs';
export const withEffectServer=(consumer)=>Effect.runPromise(Effect.scoped(Effect.gen(function* (){
  const wsRoutes=HttpRouter.add('GET','/ws',Effect.gen(function* (){
    const {protocol,httpEffect}=yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(rpcGroup).pipe(
      Effect.provide(rpcGroup.toLayerHandler('subscribe', ({count})=>
        Stream.fromIterable((function* (){
          for(let i=1;i<=count;i++)yield {kind:'delta',seq:i,text:'x'};
          yield {kind:'done',seq:count,text:''};
        })())
      )),
      Effect.provideService(RpcServer.Protocol,protocol),
      Effect.forkScoped
    );
    return yield* httpEffect;
  }).pipe(Effect.provide(RpcSerialization.layerJson)));
  const srv=yield* Layer.build(HttpRouter.serve(wsRoutes,{disableListenLog:true}).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer,{
      host:'127.0.0.1',port:0,websocket:{perMessageDeflate:false}
    }))
  ));
  const address=Context.get(srv,HttpServer.HttpServer).address;
  if(!('port' in address))throw Error('Expected TCP port');
  return yield* Effect.tryPromise(()=>consumer('ws://127.0.0.1:'+address.port+'/ws'));
})));
