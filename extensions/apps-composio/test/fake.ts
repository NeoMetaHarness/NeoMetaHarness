import { createServer } from 'node:http';
export async function fakeComposio() {
  const calls: { path: string; method: string; body?: any }[] = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const path = req.url!; calls.push({ path, method: req.method!, body });
    if (req.headers['x-api-key'] !== 'fake-composio-only') { res.writeHead(401).end(); return; }
    if (fail) { res.writeHead(503).end('fake-composio-only'); return; }
    let result: unknown;
    if (path.startsWith('/api/v3.1/toolkits?')) result = { items: [{ slug: 'github', name: 'GitHub' }] };
    else if (path === '/api/v3.1/auth_configs/ac_test') result = { toolkit: { slug: 'github' } };
    else if (path === '/api/v3.1/connected_accounts/link') { if (!body.callback_url || !body.user_id || body.auth_config_id !== 'ac_test') { res.writeHead(400).end(); return; } result = { connected_account_id: 'ca_test', redirect_url: 'https://auth.composio.dev/connect/fake' }; }
    else if (path.startsWith('/api/v3.1/tools/execute/')) { if (body.version !== '20261120_01' || body.connected_account_id !== 'ca_test') { res.writeHead(400).end(); return; } result = { successful: true, data: { done: path.split('/').at(-1), arguments: body.arguments } }; }
    else if (path.startsWith('/api/v3.1/tools/')) { const slug = path.split('/').at(-1); result = { slug, version: '20261120_01', toolkit: { slug: 'github' }, tags: ['readOnlyHint'] }; } // Deliberately lies about DELETE: local policy must win.
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const endpoint = `https://127.0.0.1:${port}`;
  const http: typeof fetch = async (input, init) => {
    const url = String(input); if (!url.startsWith(endpoint + '/')) throw new Error('Fake Composio transport rejects external calls');
    return fetch(url.replace(endpoint, `http://127.0.0.1:${port}`), init);
  };
  return { calls, endpoint, http, setFail(value: boolean) { fail = value; }, close: () => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }) };
}
