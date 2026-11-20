import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { connect, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import { neoContract } from '@neometaharness/contracts';
import { extensionIntegrity } from '../src/index.js';
import { sampleVersion } from './upgrade-fixtures.js';
const repo=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const home=await mkdtemp(join(tmpdir(),'neo-p110-'));
const installed=join(home,'installed');await mkdir(installed);
const secret='TEST_ONLY_UPGRADE_VAULT_PROJECTION';
const digest=createHash('sha256').update(secret).digest('hex');
const controls=new Map<string,string>();
const candidates=new Map<string,string>();
for(const id of ['sample-ts','sample-py'] as const){
  const control=join(home,'control',id);controls.set(id,control);
  for(const version of [1,2,3]){
    const directory=version===1?join(installed,id):join(home,`${id}-v${version}`);
    await sampleVersion(directory,id,version,control);candidates.set(`${id}:${version}`,directory);
  }
  const data=join(home,'extensions',id);await mkdir(join(data,'projections'),{recursive:true});
  await writeFile(join(data,'settings.json'),JSON.stringify({value:`preserved-${id}`}));
  await writeFile(join(data,'projections','capability'),secret,{mode:0o600});
}
type Client=ContractRouterClient<typeof neoContract>;
async function upgradeInput(id:string,version:number){
  const directory=candidates.get(`${id}:${version}`)!;
  return {id,directory,integrity:await extensionIntegrity(directory)};
}
let child:ChildProcess|undefined;let token='';let port=0;let logs='';
async function start(){
  token='';
  child=spawn(process.execPath,['--import','tsx','src/main.ts'],{cwd:join(repo,'apps/gateway'),windowsHide:true,stdio:['pipe','pipe','pipe'],
    env:{...process.env,NEO_MODE:'desktop',NEO_PRINT_DESKTOP_TOKEN:'1',NMH_DB_PATH:join(home,'gateway.db'),NMH_EXTENSIONS_DIR:installed,NMH_PORT:'0'}});
  child.stdout!.on('data',chunk=>{logs+=chunk;});child.stderr!.on('data',chunk=>{logs+=chunk;});
  port=await new Promise<number>((done,reject)=>{
    const timer=setTimeout(()=>reject(Error('Gateway startup timed out')),30000);const reader=createInterface({input:child!.stdout!});
    reader.on('line',line=>{if(line.startsWith('NEO_DESKTOP_TOKEN '))token=line.slice(18).trim();if(line.startsWith('GATEWAY_READY ')){clearTimeout(timer);reader.close();done(JSON.parse(line.slice(14)).port);}});
    child!.once('exit',()=>{clearTimeout(timer);reject(Error('Gateway exited: '+logs.slice(-1000)));});
  });
  assert.ok(token.length>16);
  return createORPCClient<Client>(new RPCLink({url:`http://127.0.0.1:${port}`,headers:{authorization:`Bearer ${token}`}}));
}
async function stop(){if(!child||child.exitCode!==null)return;const ended=new Promise(done=>child!.once('exit',done));child.stdin!.write('shutdown\n');const timer=setTimeout(()=>child!.kill(),7000);try{await ended;}finally{clearTimeout(timer);}}
async function waitFile(file:string){const end=Date.now()+10000;for(;;){try{return await readFile(file,'utf8');}catch{}if(Date.now()>end)throw Error('Fixture marker timed out: '+file);await new Promise(done=>setTimeout(done,10));}}
async function hello(id:string,path='hello',timeout=5000){const response=await fetch(`http://127.0.0.1:${port}/x/${id}/${path}`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(timeout)});assert.equal(response.status,200);return response.json() as Promise<any>;}
async function socketAt(port:number){const socket=connect(port,'127.0.0.1');socket.on('error',()=>{});await new Promise<void>((done,reject)=>{socket.once('data',()=>done());socket.once('error',reject);});return socket;}
const sockets:Socket[]=[];
try{
  let rpc=await start();
  const unauth=createORPCClient<Client>(new RPCLink({url:`http://127.0.0.1:${port}`}));
  await assert.rejects(unauth.extensions.upgrade(await upgradeInput('sample-ts',2)),(error:any)=>error.code==='UNAUTHORIZED');
  for(const id of ['sample-ts','sample-py'] as const){
    const control=controls.get(id)!;
    await rpc.vault.put({scope:{kind:'engine',workspaceId:'default',subjectId:id},name:'UPGRADE_CAPABILITY',value:secret});
    assert.equal((await rpc.extensions.enable({id})).status,'running');
    const before=await hello(id);assert.equal(before.version,1);
    const socket=await socketAt(before.port);sockets.push(socket);
    const closed=new Promise<void>(done=>socket.once('close',()=>done()));socket.resume();
    const oldRequest=hello(id,'slow');await waitFile(join(control,'slow-v1'));
    let complete=false;
    const upgrade=rpc.extensions.upgrade({...await upgradeInput(id,2),drainTimeoutMs:3000}).then(result=>{complete=true;return result;});
    await waitFile(join(control,'health-v2'));assert.equal(complete,false);
    await writeFile(join(control,'allow-v2'),'yes');
    let after:any;const end=Date.now()+5000;
    while(Date.now()<end){try{after=await hello(id,'hello',150);if(after.version===2)break;}catch{}await new Promise(done=>setTimeout(done,10));}
    assert.equal(after?.version,2);assert.equal(complete,false,'Upgrade must wait for the old request to drain');
    await writeFile(join(control,'release-v1'),'yes');assert.equal((await oldRequest).version,1);
    const result=await upgrade;assert.equal(result.upgraded,true);assert.equal(result.extension.version,'2.0.0');
    await closed;
    assert.equal(after.setting,`preserved-${id}`);assert.equal(after.projectionDigest,digest);
    if(id==='sample-ts')assert.equal(after.vaultDigest,digest);
    await waitFile(join(control,'disposed-v1'));
    const broken=await rpc.extensions.upgrade(await upgradeInput(id,3));assert.equal(broken.upgraded,false);assert.equal(broken.extension.version,'2.0.0');
    await waitFile(join(control,'disposed-v3'));
    assert.equal((await hello(id)).version,2);
    const staged=JSON.parse(await waitFile(join(control,'health-v3')));
    await assert.rejects(socketAt(staged.port),'Failed candidate must close its socket');
    await writeFile(join(candidates.get(`${id}:3`)!,'neo.extension.json'),'{invalid');
    assert.equal((await rpc.extensions.upgrade(await upgradeInput(id,3))).upgraded,false);
    assert.equal((await hello(id)).version,2);
  }
  await stop();
  for(const id of ['sample-ts','sample-py']) await rm(candidates.get(`${id}:2`)!,{recursive:true,force:true});
  rpc=await start();
  for(const id of ['sample-ts','sample-py']){
    const response=await hello(id);assert.equal(response.version,2);assert.equal(response.projectionDigest,digest);assert.equal(response.setting,`preserved-${id}`);
    assert.equal((await rpc.extensions.list()).find(value=>value.id===id)?.version,'2.0.0');
  }
  await stop();
  await rm(join(home,'extensions','generations','sample-ts@2.0.0'),{recursive:true});
  await sampleVersion(join(installed,'sample-py'),'sample-py',4,controls.get('sample-py')!);
  rpc=await start();
  const fallback=(await rpc.extensions.list()).find(value=>value.id==='sample-ts');
  assert.equal(fallback?.status,'degraded');assert.match(fallback.reason!,/using bundled 1\.0\.0/);
  assert.equal((await hello('sample-ts')).version,1);
  assert.equal((await hello('sample-py')).version,4);
  assert.equal((await rpc.extensions.list()).find(value=>value.id==='sample-py')?.status,'running');
  await rpc.extensions.disable({id:'sample-ts'});
  await stop();
  await rm(join(installed,'sample-py'),{recursive:true});
  rpc=await start();
  assert.ok(!(await rpc.extensions.list()).some(extension=>extension.id==='sample-py'),'The stale upgrade row was removed');
  assert.equal((await rpc.extensions.enable({id:'sample-ts'})).status,'running','Disable removes the broken persisted install');
  const standalone=candidates.get('sample-ts:2')!;
  await sampleVersion(standalone,'sample-ts',2,controls.get('sample-ts')!);
  assert.equal((await rpc.extensions.upgrade(await upgradeInput('sample-ts',2))).upgraded,true);
  await stop();
  await rm(join(installed,'sample-ts'),{recursive:true});
  rpc=await start();
  assert.equal((await hello('sample-ts')).version,2,'A verified kernel-owned copy can run without a bundled version');
  assert.equal((await rpc.extensions.disable({id:'sample-ts'})).status,'disabled');
  assert.ok(!(await rpc.extensions.list()).some(extension=>extension.id==='sample-ts'));
  assert.ok(!logs.includes(secret));
  console.log('PASS P1-10 authenticated TS/Python local upgrades: in-flight v1 survives atomic v2 switch, old sockets close, broken/invalid v3 rolls back, settings/vault projections and selected versions survive restart');
}finally{
  for(const control of controls.values())await writeFile(join(control,'release-v1'),'yes').catch(()=>{});
  for(const socket of sockets)socket.destroy();await stop();await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
