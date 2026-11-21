import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Minimal Honcho v3.6.1 fixture. Route references are from the pinned upstream checkout.
export async function fakeHoncho(key = 'isolated-honcho-key') {
  const sessions = new Map();
  const writes = [];
  const requests = [];
  let available = true;
  let sequence = 0;

  const server = createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    // fastapi-pagination pages (Honcho list endpoints): page is 1-based, size is the page length.
    const page = (items) => {
      const size = Number(requestUrl.searchParams.get('size') ?? 50);
      const number = Number(requestUrl.searchParams.get('page') ?? 1);
      return { items: items.slice((number - 1) * size, number * size), page: number, size,
        total: items.length, pages: Math.max(1, Math.ceil(items.length / size)) };
    };
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== 'Bearer ' + key) return send(401, { detail: 'Unauthorized' });
    if (!available) return send(503, { detail: 'Honcho unavailable' });
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const parts = [];
      for await (const part of req) parts.push(part);
      body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    }
    requests.push(req.method + ' ' + pathname);
    // src/main.py:254, GET /health.
    if (req.method === 'GET' && pathname === '/health') return send(200, { status: 'healthy' });
    // src/routers/workspaces.py:41, POST /v3/workspaces.
    if (req.method === 'POST' && pathname === '/v3/workspaces') return send(200, { id: body.id });
    const base = /^\/v3\/workspaces\/([\w-]+)(?:\/(.*))?$/.exec(pathname);
    if (!base) return send(404, { detail: pathname });
    const workspace = base[1];
    const rest = base[2] ?? '';
    // src/routers/peers.py:124, POST /{workspace_id}/peers.
    if (req.method === 'POST' && rest === 'peers') return send(200, { id: body.id });
    // src/routers/sessions.py:331, POST /{workspace_id}/sessions.
    if (req.method === 'POST' && rest === 'sessions') {
      const identifier = workspace + '/' + body.id;
      if (!sessions.has(identifier)) sessions.set(identifier, []);
      return send(200, { id: body.id });
    }
    // src/routers/sessions.py:272, POST /{workspace_id}/sessions/list.
    if (req.method === 'POST' && rest === 'sessions/list') {
      return send(200, page([...sessions.keys()].filter((id) => id.startsWith(workspace + '/'))
        .map((id) => ({ id: id.slice(workspace.length + 1) }))));
    }
    // Upstream src/routers/messages.py GET and PUT /{session_id}/messages/{message_id} (the PUT updates metadata),
    // as already called by HonchoStore.update/delete. Line numbers not cited: no pinned Honcho checkout is cached.
    const messageRoute = /^sessions\/([\w-]+)\/messages\/(message_\d+)$/.exec(rest);
    if (messageRoute) {
      const message = sessions.get(workspace + '/' + messageRoute[1])?.find((item) => item.id === messageRoute[2]);
      if (!message) return send(404, { detail: 'Unknown message' });
      if (req.method === 'GET') return send(200, message);
      if (req.method === 'PUT') { message.metadata = body.metadata ?? message.metadata; return send(200, message); }
    }
    const sessionRoute = /^sessions\/([\w-]+)\/(messages|messages\/list|context)$/.exec(rest);
    if (sessionRoute) {
      const session = sessionRoute[1];
      const operation = sessionRoute[2];
      const stored = sessions.get(workspace + '/' + session);
      if (!stored) return send(404, { detail: 'Unknown session' });
      // src/routers/messages.py:113-126, POST /{session_id}/messages.
      if (req.method === 'POST' && operation === 'messages') {
        assert.ok(Array.isArray(body.messages), 'Honcho messages batch required');
        const created = body.messages.map((message) => ({
          ...message, id: 'message_' + (++sequence), session_id: session,
          workspace_id: workspace, created_at: new Date().toISOString(),
        }));
        stored.push(...created);
        writes.push(...created);
        return send(200, created);
      }
      // src/routers/messages.py:325, POST /{session_id}/messages/list.
      if (req.method === 'POST' && operation === 'messages/list') return send(200, page([...stored].reverse()));
      // src/routers/sessions.py:744-748, GET /{session_id}/context.
      if (req.method === 'GET' && operation === 'context') {
        return send(200, { id: session, messages: [...stored], summary: null,
          peer_representation: null, peer_card: null });
      }
    }
    // src/routers/workspaces.py:301-315, POST /{workspace_id}/chat.
    if (req.method === 'POST' && rest === 'chat') return send(200, { content: 'Honcho test context for ' + body.query });
    return send(404, { detail: 'Unimplemented fake Honcho endpoint ' + pathname });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: 'http://127.0.0.1:' + address.port,
    writes,
    requests,
    outage(value) { available = !value; },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
