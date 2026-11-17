import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { withEffectServer } from './api-effect-server.mjs';
import { consumeEffect } from './api-effect-client.mjs';
import { withOrpcServer } from './api-orpc-server.mjs';
import { consumeOrpc } from './api-orpc-client.mjs';
import { upstreamPath } from './upstream-path.mjs';
import fs from 'node:fs';
const count=2000, trials=5;
assert.ok(fs.existsSync(upstreamPath('t3code','packages/contracts/src/rpc.ts')));
const implementations=[
  {name:'effect-ws',server:withEffectServer,client:consumeEffect,entry:'api-effect-client.mjs'},
  {name:'orpc-ws',server:withOrpcServer,client:consumeOrpc,entry:'api-orpc-client.mjs'}
];
const samples={};
for (const {name,server,client,entry} of implementations) {
  const times=[],firstDeltas=[];
  for (let i=0;i<=trials;i++) {
    const result=await server(async url=>{
      const start=performance.now();
      const value=await client(url,count);
      return {elapsed:performance.now()-start,value};
    });
    assert.equal(result.value.seen,count);
    assert.equal(result.value.done,1);
    assert.ok(result.value.firstDeltaMs>0 && result.value.firstDeltaMs<=result.elapsed);
    if(i) {times.push(Math.round(result.elapsed*100)/100);firstDeltas.push(Math.round(result.value.firstDeltaMs*100)/100);}
  }
  const sorted=[...times].sort((a,b)=>a-b);
  const bundled=await build({entryPoints:[entry],bundle:true,write:false,platform:'browser',target:'es2022',format:'esm',minify:true,treeShaking:true,logLevel:'silent'});
  const bytes=Buffer.concat(bundled.outputFiles.map(x=>x.contents));
  const firstSorted=[...firstDeltas].sort((a,b)=>a-b);
  samples[name]={runsMs:times,firstDeltaMs:firstDeltas,medianCompletionMs:sorted[Math.floor(sorted.length/2)],medianFirstDeltaMs:firstSorted[Math.floor(firstSorted.length/2)],bundleBytes:bytes.byteLength,bundleGzipBytes:gzipSync(bytes).byteLength};
  console.log(name+' PASS '+JSON.stringify(samples[name]));
}
const baseline=await build({stdin:{contents:'export function ping(x){return x}',resolveDir:process.cwd(),sourcefile:'empty.mjs'},bundle:true,write:false,platform:'browser',format:'esm',minify:true,logLevel:'silent'});
console.log('baselineBytes='+baseline.outputFiles[0].contents.byteLength+' node='+process.version+' deltas='+count+' trials='+trials+' warmup=1; WS loopback 127.0.0.1');
console.log('API_BENCHMARK PASS');
