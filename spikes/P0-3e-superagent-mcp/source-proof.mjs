import { strict as assert } from 'node:assert';
import { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { SourceRegistry, HealthBoard, sourceContextOf, assessmentOutcome } from './dist/superagent.mjs';

const stored = new Map();
const state = { sources: {} };
const board = new HealthBoard();
const registry = new SourceRegistry(() => state, board);
const seen = new Set();
const deliveries = [];
let failId = null;
let configured = true;
const deps = {
  sources: registry, ready: Promise.resolve(), configured: () => configured,
  deployment: {}, commands: {}, engine: {bindThread(){}, threadClosed(){}},
  outbox:{send(){}},
  store:{
    atomic: work => work(), get: name => stored.get(name),
    set: (name,value) => stored.set(name,value),
    delete: name => stored.delete(name), keys: prefix => [...stored.keys()].filter(x=>x.startsWith(prefix)),
    threads:{get(){},describe(){},patchMeta(){}},tickets:{get(){},open(){return []}},
    triggers:{get(){}},read:{subscribedThreads(){return []},threadTriggers(){return []}},
  },
  receive: async trigger => {
    if (trigger.id === failId) throw Error('fixture failed before acknowledgment');
    if (seen.has(trigger.id)) return {kind:'duplicate'};
    seen.add(trigger.id); deliveries.push(trigger); return {kind:'received'};
  },
};
const kind = {
  kind:'neo/fixture', title:{en:'Neo fixture',zh:'Neo fixture'},description:{en:'Fixture',zh:'Fixture'},
  health:['neo-fixture'], fields: [],
  schema:z.object({feed:z.string().default('inbox'),enabled:z.boolean().default(true)}),
  scope: ({meta}, config) => meta.feed === config.feed
    ? {listened:true,observed:false,row:config.feed}
    : {listened:false,reason:'wrong_feed'},
};
const ctx = new Context();
const plugin = { name:'neo-source-fixture', apply(owner) { owner.effect(() => registry.register(kind)); } };
const mounted = await ctx.plugin(plugin);
assert.equal(registry.kind(kind.kind), kind);
assert.equal(registry.instances().length,1);
assert.equal(registry.scope({source:kind.kind,meta:{feed:'unknown'}}).listened,false);
assert.equal(registry.scope({source:kind.kind,meta:{feed:'inbox'}}).listened,true);
assert.match(JSON.stringify(board.all),/neo-fixture/);
assert.throws(()=>registry.register(kind), /already registered/);
assert.throws(()=>registry.register({...kind,kind:'neo/other',health:['neo-fixture']}), /health entry/);
assert.throws(()=>registry.validate(kind.kind,{enabled:true,config:{feed:12}}));
const c = sourceContextOf(deps,kind);
const queue = [
  {id:'m1',feed:'inbox',text:'first',at:'2026-11-17T00:00:01Z'},
  {id:'m2',feed:'inbox',text:'second',at:'2026-11-17T00:00:02Z'},
  {id:'m3',feed:'inbox',text:'third',at:'2026-11-17T00:00:03Z'},
];
const triggerOf = e => ({id:`neo/fixture:${e.id}`,source:kind.kind,threads:[{source:kind.kind,id:'inbox'}],
  actor:{source:kind.kind,id:'human1'},human:true,at:e.at,text:e.text,meta:{feed:e.feed}});
const runRound = async () => {
  await c.ready;
  if (!c.config(kind.kind) || !c.configured()) { c.report('neo-fixture',{state:'paused',detail:'Source disabled'});return; }
  const cursor = c.state.get('neo-fixture:cursor') ?? 0;
  for(let i=cursor;i<queue.length;i++) {
    const trigger=triggerOf(queue[i]);
    try { await c.receive(trigger); c.atomic(()=>c.state.set('neo-fixture:cursor',i+1)); }
    catch(error) { c.report('neo-fixture',{state:'error',detail:String(error)});throw error; }
  }
  c.report('neo-fixture',{state:'ready',detail:'Fixture synchronized'});
};
failId='neo/fixture:m2';
await assert.rejects(runRound(),/fixture failed/);
assert.equal(c.state.get('neo-fixture:cursor'),1);
assert.deepEqual(deliveries.map(t=>t.id),['neo/fixture:m1']);
assert.equal(board.all['neo-fixture'].state,'error');
failId=null;await runRound();
assert.deepEqual(deliveries.map(t=>t.id),['neo/fixture:m1','neo/fixture:m2','neo/fixture:m3']);
assert.equal(c.state.get('neo-fixture:cursor'),3);
// Explicit rewind must replay stable IDs, with the ingestion boundary deduplicating.
c.state.set('neo-fixture:cursor',0);await runRound();
assert.equal(deliveries.length,3);
state.sources[kind.kind]={enabled:false,config:{feed:'inbox'}};
assert.equal(registry.scope({source:kind.kind,meta:{feed:'inbox'}}).reason,'source_disabled');
assert.equal(c.config(kind.kind),undefined);
c.state.set('neo-fixture:cursor',0);await runRound();assert.equal(deliveries.length,3);
assert.equal(board.all['neo-fixture'].state,'paused');
configured=false;state.sources[kind.kind]={enabled:true,config:{feed:'inbox'}};
await runRound();assert.equal(deliveries.length,3);
configured=true;
// Admission is a separate upstream policy decision; a Source has no accept() method.
const outcome = assessmentOutcome({decision:'accept',rule_assessments:[],direction:{
  implementation_requested:true,target_basis:'specified',requires_design_decision:false,evidence:'fixture'},
  title:'proposed task',scope:'inbox',reason:'fixture',intent_evidence:'fixture message'},
  {policy:{rules:[]},eval:{mode:'observe'}},'explicit');
assert.equal(outcome.kind,'ignore');
await mounted.dispose();
assert.equal(registry.kind(kind.kind),undefined);
assert.equal(Object.keys(board.all).length,0);
const before = Object.keys(board.all).length;
c.report('neo-fixture',{state:'error',detail:'late report'});
assert.equal(Object.keys(board.all).length,before);
await ctx.fiber.dispose();
console.log('SOURCE_REGISTRY PASS registration, duplicate kind/health, validation, scope');
console.log('SOURCE_INGEST PASS failure kept cursor=1; recovered ids=m1,m2,m3; rewind deduped=3');
console.log('SOURCE_STATE PASS disabled/unconfigured skipped; health ready/error/paused; disposed registration & health');
console.log('SOURCE_POLICY PASS upstream assessment with no matched rules ignored');
