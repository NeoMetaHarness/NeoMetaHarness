import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelBus } from '../src/channel-bus.js';
test('durable notifications never acknowledge an absent transport', async () => {
  const bus = new ChannelBus();
  const reply = { channelId: 'whatsapp:test:15550001111@s.whatsapp.net', inReplyTo: 'item', text: 'PR confirmed' };
  await assert.rejects(bus.reply({ ...reply, requireDelivery: true }), /unavailable/);
  assert.equal(bus.replies.length, 0);
  let delivered = 0;
  const detach = bus.attach('whatsapp', { inbound: async () => ({ status: 200 }), deliver: async () => { delivered++; } });
  await bus.reply({ ...reply, requireDelivery: true }); assert.equal(delivered, 1);
  detach();
  await assert.rejects(bus.reply({ ...reply, requireDelivery: true }), /unavailable/);
  await bus.reply(reply); assert.equal(bus.replies.length, 1, 'Legacy scripted channel sink remains available');
});
