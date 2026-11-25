import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { HeadlessChromeProvider } from '../../../extensions/computer-headless-chrome/src/index.ts';

const app = fileURLToPath(new URL('..', import.meta.url));
const chrome = new HeadlessChromeProvider();
let server;
try {
  server = await createServer({ root: app, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  await chrome.attach('stream-view');
  const channel = chrome.browser('stream-view');
  const { sessionId } = await channel.send('Target.attachToTarget', { targetId: channel.targetId, flatten: true });
  const send = (method, params) => channel.send(method, params, sessionId);
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true });
    assert.ok(!response.exceptionDetails, response.result.description);
    return response.result.value;
  };
  const eventually = async (expression) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    assert.fail(`Timed out: ${expression}`);
  };
  const append = (text) => evaluate(`stream.append(${JSON.stringify(text)})`);
  const finish = () => evaluate('stream.finish()');
  const reset = async () => {
    await evaluate('stream.reset()');
    await eventually('!document.querySelector("[aria-live=polite]").textContent.trim()');
  };
  await send('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/test/stream-view.html` });
  await eventually('Boolean(window.stream)');

  await append('Intro.\n\nRead [the guide][gu');
  await append('ide].\n\nMiddle paragraph.\n');
  await eventually('document.querySelector(".neo-stream-tail").textContent.includes("Middle paragraph")');
  await append('\n[guide]: https://example.com/guide\n\nAfter definition.\n');
  await eventually(`document.querySelector('a[href="https://example.com/guide"]')?.textContent === 'the guide'`);
  await finish();
  await reset();
  await append('[guide]: https://example.com/guide\n\nMiddle paragraph.\n\nRead [the guide][guide].');
  await finish();
  await eventually(`document.querySelector('a[href="https://example.com/guide"]')?.textContent === 'the guide'`);
  console.log('StreamView reference links PASS (forward while streaming, backward at finish)');

  await reset();
  await append('1. First item\n\n   ```js\n   const first = 1;\n');
  await append('   ```\n\n2. Second item\n\nAfter list.\n');
  await finish();
  await eventually('document.querySelector("ol")?.children.length === 2');
  assert.equal(await evaluate('document.querySelectorAll("ol").length'), 1);
  assert.ok(await evaluate('document.querySelector("ol > li:first-child pre").textContent.includes("const first = 1;")'));
  console.log('StreamView fenced numbered list PASS');

  await reset();
  await append('Live response');
  await eventually('document.querySelector(".neo-stream-tail").textContent === "Live response"');
  assert.equal(await evaluate('document.querySelector(".neo-stream-tail").closest("[aria-live=polite]").getAttribute("aria-live")'), 'polite');
  await finish();
  await eventually(`(() => {
    const tail = document.querySelector('.neo-stream-tail');
    return !tail.textContent && tail.closest('[aria-live=polite]').textContent.includes('Live response');
  })()`);
  console.log('StreamView live region PASS (streaming and finished content)');
} finally {
  await chrome.dispose();
  await server?.close();
}
