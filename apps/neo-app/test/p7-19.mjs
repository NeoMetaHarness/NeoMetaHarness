import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { RPCLink as WebSocketLink } from '@orpc/client/websocket';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.ts';
import { startGateway } from '../../gateway/src/server.ts';
import { hermesCalls, t3Calls } from './p7-19-engines.ts';

const temp = await mkdtemp(join(tmpdir(), 'nmh-p7-19-'));
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const extensionsDir = join(temp, 'extensions');
const chrome = new HeadlessChromeProvider();
const fixture = new URL('./p7-19-engines.ts', import.meta.url).href;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const contentTypes = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const app = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const name = /^\/assets\/[\w.-]+$/.test(path) ? path.slice(1) : 'index.html';
  try {
    const bytes = await readFile(join(dist, name));
    res.writeHead(200, { 'content-type': contentTypes[extname(name)] ?? 'application/octet-stream' })
      .end(bytes);
  } catch { res.writeHead(404).end(); }
});

async function installFixture(id, entry, source) {
  const directory = join(extensionsDir, id);
  await mkdir(directory, { recursive: true });
  if (source) await writeFile(join(directory, entry), source);
  await writeFile(join(directory, 'neo.extension.json'), JSON.stringify({
    id, version: '0.1.0', displayName: id, runtime: { type: 'cordis', entry },
  }));
}

let gateway;
try {
  const a2ui = new URL('../../../extensions/a2ui/src/index.ts', import.meta.url).href;
  await installFixture('a2ui', 'fixture.mjs', `export { default } from ${JSON.stringify(a2ui)};`);
  await installFixture('engine-hermes', 'fixture.mjs', `export { hermes as default } from ${JSON.stringify(fixture)};`);
  await installFixture('engine-t3', 'fixture.mjs', `export { t3 as default } from ${JSON.stringify(fixture)};`);
  gateway = await startGateway({ databaseFile: join(temp, 'neo.db'), extensionsDir, dataDir: temp, mode: 'desktop' });
  const base = `http://127.0.0.1:${gateway.port}`;
  const token = gateway.desktopToken;
  const rpc = createORPCClient(new RPCLink({ url: base, headers: { authorization: 'Bearer ' + token } }));
  for (const id of ['a2ui', 'engine-hermes']) assert.equal((await rpc.extensions.enable({ id })).status, 'running');
  await new Promise((done) => app.listen(0, '127.0.0.1', done));
  await chrome.attach('p7-19');
  const channel = chrome.browser('p7-19');
  const { targetId } = await channel.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await channel.send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params = {}) => channel.send(method, params, sessionId);
  const query = new URLSearchParams({ gateway: base, token });
  const visit = (path, parameters = {}) => cdp('Page.navigate', {
    url: `http://127.0.0.1:${app.address().port}/${path}?${new URLSearchParams([...query, ...Object.entries(parameters)])}`,
  });
  const evaluate = async (expression) => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const find = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
  const click = (selector) => evaluate(`${find(selector)}.click()`);
  async function eventually(expression, message) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (await evaluate(expression)) return;
      await delay(75);
    }
    throw new Error(`${message}\n${await evaluate('document.body.innerText.slice(-1600)')}`);
  }
  async function enter() {
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
    await cdp('Input.dispatchKeyEvent', { ...key, type: 'keyDown' });
    await cdp('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
  }
  async function type(selector, text) {
    await evaluate(`${find(selector)}.focus()`);
    await cdp('Input.insertText', { text });
  }
  async function prompt(selector, text) {
    await eventually(`!!${find(selector)}`, 'Chat composer unavailable');
    await type(selector, text);
    await enter();
  }
  async function survey() {
    await eventually(`!!${find('.neo-a2ui-surface button:not([aria-disabled=true])')}`, 'A2UI form unavailable');
    await eventually(`${find('.neo-a2ui-surface strong')}?.textContent === "Bold note"`, 'Markdown did not render');
    assert.equal(await evaluate(`!!${find('.neo-a2ui-surface a, .neo-a2ui-surface img, .neo-a2ui-surface [onerror]')}`), false);
    assert.equal(await evaluate('document.body.innerText.includes("Before the form.") && document.body.innerText.includes("After the form.")'), true);
    for (const [mode, text, background, border] of [
      ['light', 'rgb(24, 35, 53)', 'rgb(255, 255, 255)', 'rgb(201, 209, 224)'],
      ['dark', 'rgb(237, 242, 255)', 'rgb(25, 34, 49)', 'rgb(57, 72, 97)'],
    ]) {
      await evaluate(`(() => {
        localStorage.setItem('neo.appearance', '${mode}');
        window.dispatchEvent(new StorageEvent('storage', {
          storageArea: localStorage, key: 'neo.appearance', newValue: '${mode}',
        }));
      })()`);
      await eventually(`document.documentElement.dataset.theme === '${mode}'`, `Neo did not apply ${mode} appearance`);
      const colors = await evaluate(`(() => {
        const style = getComputedStyle(${find('.neo-a2ui-surface')});
        const input = getComputedStyle(${find('.neo-a2ui-surface input[type=text]')});
        return [style.color, style.backgroundColor, style.borderColor, input.color];
      })()`);
      assert.deepEqual(colors, [text, background, border, text]);
    }
    await click('.neo-a2ui-surface input[type=checkbox]');
    await type('.neo-a2ui-surface input[type=text]', 'Ada');
    await enter();
  }
  const checkAction = (serialized) => {
    const { version, action } = JSON.parse(serialized.split('\n\n')[0]);
    assert.equal(version, '1.0');
    assert.equal(action.name, 'submit');
    assert.deepEqual(action.context, { name: 'Ada', approved: true });
  };

  await visit('agents');
  await eventually(`!!${find('[data-testid=open-default]')}`, 'Hermes bot not listed');
  await click('[data-testid=open-default]');
  await eventually(`!!${find('.agents-conversation input[type=checkbox]')}`, 'Interactive replies switch missing');
  await click('.agents-conversation input[type=checkbox]');
  const agentsComposer = '.agents-conversation [contenteditable=true]';
  await prompt(agentsComposer, 'Show a form');
  await survey();
  await eventually('document.body.innerText.includes("Hermes received your survey.")', 'Missing Hermes follow-up');
  assert.match(hermesCalls[0].instructions, /neometaharness:chat:v1/);
  assert.ok(hermesCalls[1].sessionId?.startsWith('hermes-'));
  checkAction(hermesCalls[1].input);
  assert.equal((await rpc.extensions.disable({ id: 'a2ui' })).status, 'disabled');
  await eventually(`!${find('.neo-a2ui-surface')} && document.body.innerText.includes("createSurface")`, 'Disabled A2UI did not restore plain text');
  await prompt(agentsComposer, 'ordinary follow-up');
  await eventually('document.body.innerText.includes("Hermes plain text continues.")', 'Disabled A2UI interrupted Hermes chat');
  assert.equal(hermesCalls[2].sessionId, hermesCalls[1].sessionId);
  assert.equal(hermesCalls[2].instructions, undefined);
  console.log('P7-19_HERMES PASS same_session=true markdown_sanitized=true theme_tokens=true disabled_plain_text=true');

  assert.equal((await rpc.extensions.enable({ id: 'a2ui' })).status, 'running');
  assert.equal((await rpc.extensions.enable({ id: 'engine-t3' })).status, 'running');
  assert.equal((await rpc.extensions.disable({ id: 'engine-hermes' })).status, 'disabled');
  await visit('coding');
  await eventually(`!!${find('.coding-create input[type=checkbox]')}`, 'Interactive thread option missing');
  await type('[data-testid=coding-title]', 'Interactive fixture');
  await click('.coding-create input[type=checkbox]');
  await click('.coding-create button[type=submit]');
  const codingComposer = '.coding-conversation [contenteditable=true]';
  await eventually(`!!${find(codingComposer)} && ${find('[data-testid=coding-status]')}?.textContent === "Ready"`,
    'T3 thread not subscribed');
  await prompt(codingComposer, 'Show a form');
  await survey();
  await eventually('document.body.innerText.includes("T3 received your survey.")', 'Missing T3 follow-up');
  assert.match(t3Calls[0].text, /neometaharness:chat:v1/);
  assert.equal(t3Calls[1].threadId, t3Calls[0].threadId);
  checkAction(t3Calls[1].text);
  assert.equal(await evaluate('document.body.innerText.includes("A T3 revision that is replaced.")'), false);
  await visit('coding', { openThread: t3Calls[0].threadId });
  await eventually(`!!${find('.neo-a2ui-surface button[aria-disabled=true]')}`, 'Historical T3 surface did not restore read-only');
  console.log('P7-19_T3 PASS same_thread=true keyboard_submit=true revised_text=true snapshot=true single_engine=true');

  await chrome.release('p7-19');
  await gateway.close();
  gateway = undefined;
  gateway = await startGateway({ databaseFile: join(temp, 'server.db'), extensionsDir,
    dataDir: join(temp, 'server-data'), mode: 'server', signup: 'open' });
  const serverBase = `http://127.0.0.1:${gateway.port}`;
  async function auth(path, body, bearer) {
    const response = await fetch(serverBase + '/auth/' + path, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
    });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  async function signUp(name) {
    const result = await auth('sign-up/email', { name, email: name + '@a2ui.test', password: 'LocalFixture!1234' });
    return result.token;
  }
  const clientFor = (bearer) => createORPCClient(new RPCLink({ url: serverBase, headers: { authorization: 'Bearer ' + bearer } }));
  const owner = await signUp('owner');
  const alpha = await auth('organization/create', { name: 'Alpha', slug: 'alpha' }, owner);
  const beta = await auth('organization/create', { name: 'Beta', slug: 'beta', keepCurrentActiveOrganization: true }, owner);
  async function member(name, organizationId, role) {
    const token = await signUp(name);
    const invite = await auth('organization/invite-member', { email: name + '@a2ui.test', organizationId, role }, owner);
    await auth('organization/accept-invitation', { invitationId: invite.id }, token);
    return clientFor(token);
  }
  const outsider = await member('outsider', beta.id, 'member');
  const viewer = await member('viewer', alpha.id, 'viewer');
  const ownerClient = clientFor(owner);
  for (const id of ['a2ui', 'engine-hermes', 'engine-t3']) {
    assert.equal((await ownerClient.extensions.enable({ id })).status, 'running');
  }
  const started = await ownerClient.x['engine-hermes'].runs.start({ profile: 'default', input: 'Show survey', interactive: true });
  const socket = new WebSocket(serverBase.replace('http:', 'ws:') + '/ws', ['bearer.' + owner]);
  let handle;
  try {
    const wsrpc = createORPCClient(new WebSocketLink({ websocket: socket }));
    for await (const event of await wsrpc.x['engine-hermes'].runs.events({ profile: 'default', runId: started.run_id })) {
      if (event.type === 'a2ui.message') handle = event.payload.find((segment) => segment.kind === 'surface').actions.submit.handle;
    }
  } finally { socket.close(); }
  assert.ok(handle);
  const input = { handle, idempotencyKey: randomUUID(), fields: { name: 'Neo', approved: true } };
  await assert.rejects(outsider.x.a2ui.action(input), { code: 'NOT_FOUND' });
  await assert.rejects(viewer.x.a2ui.action(input), { code: 'FORBIDDEN' });
  await assert.rejects(ownerClient.x.a2ui.action({ ...input, fields: { injected: true } }), { code: 'BAD_REQUEST' });
  const before = hermesCalls.length;
  const [first, retry] = await Promise.all([ownerClient.x.a2ui.action(input), ownerClient.x.a2ui.action(input)]);
  assert.deepEqual(first, retry);
  assert.equal(hermesCalls.length, before + 1);
  assert.equal(first.conversationId, started.conversationId);
  const { threadId } = await ownerClient.x['engine-t3'].create({
    threadId: randomUUID(), projectId: 'fixture-project', title: 'Alpha thread', providerId: 'neo-coding', model: 'fixture', interactive: true,
  });
  assert.ok(threadId);
  assert.equal((await outsider.x['engine-t3'].threads.list()).threads.some((thread) => thread.id === threadId), false);
  await assert.rejects(outsider.x['engine-t3'].send({ threadId, text: 'Rejected', interactive: true }), { code: 'NOT_FOUND' });
  console.log('P7-19_POLICY PASS cross_workspace=denied viewer=denied replay=deduplicated');
} finally {
  await chrome.release('p7-19');
  await gateway?.close();
  if (app.listening) await new Promise((done) => app.close(done));
  await rm(temp, { recursive: true, force: true });
}
