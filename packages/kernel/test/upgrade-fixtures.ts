import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

export async function unsealFixtureTree(directory: string): Promise<void> {
  const info = await lstat(directory).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!info?.isDirectory()) return;
  if (process.platform === 'win32') {
    await promisify(execFile)(join(process.env.SystemRoot!, 'System32', 'icacls.exe'),
      [directory, '/reset', '/T', '/Q'], { windowsHide: true, timeout: 10000 });
    return;
  }
  await chmod(directory, 0o755);
  for (const name of await readdir(directory)) await unsealFixtureTree(join(directory, name));
}

export async function sampleVersion(directory: string, id: 'sample-ts' | 'sample-py', version: number, control: string) {
  await mkdir(directory, { recursive: true }); await mkdir(control, { recursive: true });
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({ id, version: `${version}.0.0`, displayName: id, kind: ['feature'],
    runtime: id === 'sample-ts' ? { type: 'cordis', entry: './index.mjs' } : { type: 'process', protocol: 'jsonrpc',
      command: version === 1 || version === 4 ? ['uv', 'run', '--no-project', '--offline', 'python', 'extension.py'] : ['python', 'extension.py'],
      routeTimeoutMs: { hang: 150 } } }));
  if (id === 'sample-ts') {
    const code = `import { createServer } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const id=@@ID@@, version=@@VERSION@@, control=@@CONTROL@@;
const wait=async(file)=>{for(;;){try{await readFile(file);return;}catch{} await new Promise(done=>setTimeout(done,10));}};
export default { async activate(ctx) {
  const data=join(ctx.inject('extensionDataDir'),id); await mkdir(data,{recursive:true});
  const sockets=new Set(); let closed=false;
  const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));socket.write('v'+version);});
  await new Promise(done=>server.listen(0,'127.0.0.1',done)); const port=server.address().port;
  const close=()=>{if(closed)return;closed=true;for(const socket of sockets)socket.end();server.close();};
  ctx.onDrain(close); ctx.effect(()=>async()=>{close();for(const socket of sockets)socket.destroy();await writeFile(join(control,'disposed-v'+version),'yes');});
  ctx.provide('sampleTsService',{version}); ctx.contribute('tools',{id:id+'.echo',name:'v'+version});
  ctx.health(async()=>{await writeFile(join(control,'health-v'+version),JSON.stringify({port,pid:process.pid}));if(version===2)await wait(join(control,'allow-v2'));return {ok:version!==3};});
  const response=async()=>({version,port,pid:process.pid,setting:JSON.parse(await readFile(join(data,'settings.json'),'utf8')).value,
    projectionDigest:createHash('sha256').update(await readFile(join(data,'projections','capability'))).digest('hex'),
    vaultDigest:createHash('sha256').update(await ctx.inject('vault').get({kind:'engine',workspaceId:'default',subjectId:id},'UPGRADE_CAPABILITY')).digest('hex')});
  ctx.route('hello',response);
  ctx.route('slow',async()=>{await writeFile(join(control,'slow-v'+version),'yes');await wait(join(control,'release-v'+version));return response();});
} };`;
    await writeFile(join(directory, 'index.mjs'), code.replaceAll('@@ID@@', JSON.stringify(id)).replaceAll('@@VERSION@@', String(version)).replaceAll('@@CONTROL@@', JSON.stringify(control)));
  } else {
    await writeFile(join(directory, 'fixture_values.py'), `VERSION=${version}\n`);
    const code = `import json, os, sys, time, socket, threading, hashlib
from fixture_values import VERSION
ID=@@ID@@
CONTROL=@@CONTROL@@
data=None
listener=socket.socket(); listener.bind(('127.0.0.1',0)); listener.listen()
PORT=listener.getsockname()[1]
sockets=[]
def accept():
    while True:
        try:
            connection,_=listener.accept(); sockets.append(connection); connection.sendall(('v'+str(VERSION)).encode())
        except OSError: return
threading.Thread(target=accept,daemon=True).start()
def wait(file):
    while not os.path.exists(file): time.sleep(0.01)
def response():
    with open(os.path.join(data,'settings.json')) as file: setting=json.load(file)['value']
    with open(os.path.join(data,'projections','capability'),'rb') as file: digest=hashlib.sha256(file.read()).hexdigest()
    return {'version':VERSION,'port':PORT,'pid':os.getpid(),'setting':setting,'projectionDigest':digest,'noBytecode':os.environ.get('PYTHONDONTWRITEBYTECODE')=='1'}
def handle(method,params):
    global data
    if method=='initialize':
        data=params['dataDir']; os.makedirs(data,exist_ok=True)
        with open(os.path.join(data,'initialized'),'w') as file: file.write(str(VERSION))
        return {'routes':[{'path':'hello'},{'path':'slow'},{'path':'hang'}],'contributions':[{'kind':'tools','id':ID+'.echo','name':'v'+str(VERSION)}]}
    if method=='health':
        with open(os.path.join(CONTROL,'health-v'+str(VERSION)),'w') as file: json.dump({'port':PORT,'pid':os.getpid()},file)
        if VERSION==2: wait(os.path.join(CONTROL,'allow-v2'))
        return {'ok':VERSION!=3,'pid':os.getpid()}
    if method=='route.invoke':
        if params['path']=='hang':
            open(os.path.join(CONTROL,'hang-v'+str(VERSION)),'w').close(); wait(os.path.join(CONTROL,'release-hang'))
        if params['path']=='slow':
            open(os.path.join(CONTROL,'slow-v'+str(VERSION)),'w').close(); wait(os.path.join(CONTROL,'release-v'+str(VERSION)))
        return response()
    if method=='shutdown':
        listener.close()
        for connection in sockets: connection.close()
        with open(os.path.join(CONTROL,'disposed-v'+str(VERSION)),'w') as file: file.write('yes')
        return {'ok':True}
    raise ValueError('unknown method')
for line in sys.stdin:
    request=json.loads(line)
    try: result={'jsonrpc':'2.0','id':request['id'],'result':handle(request['method'],request.get('params') or {})}
    except Exception as error: result={'jsonrpc':'2.0','id':request['id'],'error':{'message':str(error)}}
    print(json.dumps(result),flush=True)
    if request['method']=='shutdown': break
`;
    await writeFile(join(directory, 'extension.py'), code.replaceAll('@@ID@@', JSON.stringify(id)).replaceAll('@@CONTROL@@', JSON.stringify(control)));
  }
}
