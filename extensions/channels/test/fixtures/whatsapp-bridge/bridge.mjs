// Test-only stand-in for Hermes' WhatsApp Node bridge (scripts/whatsapp-bridge/bridge.js at
// v0.23.2). It serves the HTTP surface the Python adapter uses (plugins/platforms/whatsapp/
// adapter.py: /auth-proof HMAC, bearer-guarded /health, /messages, /send) and no WhatsApp
// connection. Hermes spawns it as `node bridge.mjs --port P --session S --mode M` with
// HERMES_WHATSAPP_BRIDGE_TOKEN in its env. Test control uses the same bearer token:
// POST /__test/inbound {from, text} queues a DM; GET /__test/sent lists what was sent.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const arg = (name) => {
  const index = process.argv.indexOf('--' + name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const port = Number(arg('port'));
const session = arg('session');
const token = process.env.HERMES_WHATSAPP_BRIDGE_TOKEN ?? '';
const queue = [];
const sent = [];
let next = 1;

const authorized = (req) => {
  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from('Bearer ' + token);
  return token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
};
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const read = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (path === '/auth-proof') {
    const challenge = String(req.headers['x-hermes-bridge-challenge'] ?? '');
    json(res, 200, { authProof: createHmac('sha256', token).update(challenge).digest('hex') });
    return;
  }
  if (!authorized(req)) { json(res, 401, { error: 'Unauthorized' }); return; }
  if (path === '/health') {
    json(res, 200, { status: 'connected', queueLength: queue.length, uptime: process.uptime(), session,
      sendReadReceipts: false, capabilities: { outboundMentions: false } });
  } else if (path === '/messages') {
    json(res, 200, queue.splice(0));
  } else if (path === '/send' && req.method === 'POST') {
    const body = await read(req);
    const messageId = 'fake-out-' + next++;
    sent.push({ chatId: body.chatId, message: body.message, messageId });
    json(res, 200, { success: true, messageId, messageIds: [messageId] });
  } else if (['/typing', '/read', '/edit'].includes(path)) {
    json(res, 200, { success: true });
  } else if (path === '/__test/inbound' && req.method === 'POST') {
    const body = await read(req);
    const jid = String(body.from) + '@s.whatsapp.net';
    queue.push({ messageId: 'fake-in-' + next++, chatId: jid, senderId: jid, senderName: 'Tester ' + body.from,
      chatName: 'Tester ' + body.from, isGroup: false, body: String(body.text), hasMedia: false, mediaType: '',
      mime: '', mediaUrls: [], mentionedIds: [], botIds: [], timestamp: Math.floor(Date.now() / 1000) });
    json(res, 200, { ok: true });
  } else if (path === '/__test/sent') {
    json(res, 200, sent);
  } else {
    json(res, 404, { error: 'Not found' });
  }
}).listen(port, '127.0.0.1', () => console.log('fake WhatsApp bridge on ' + port));
