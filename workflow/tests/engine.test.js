'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Engine,reconcile}=require('../engine');
const {initialStages,inputFields,officialUrl,stageInput,digest,publicJob}=require('../contracts');
const {paidAllowed,authenticate}=require('../auth');
class MemoryStore {
  constructor(input={transcript:'Texto.'}){this.row={id:randomUUID(),owner_id:randomUUID(),version:0,created_at:new Date().toISOString(),document:{input,stages:initialStages(),artifacts:[],requests:[]}};}
  async get(id,owner){assert.equal(id,this.row.id);assert.equal(owner,this.row.owner_id);return structuredClone(this.row);}
  async mutate(id,owner,fn){await this.get(id,owner);const doc=structuredClone(this.row.document);const result=fn(doc);if(!result?.unchanged){this.row.document=doc;this.row.version++;}return{row:structuredClone(this.row),result:result?.unchanged?result.value:result};}
  async put(){throw Error('Unexpected artifact effect');}
}
function setup(providers,input){const store=new MemoryStore(input);const user={id:store.row.owner_id};const engine=new Engine({store,providers,paidAllowed:()=>true});return{store,user,engine,id:store.row.id};}
function request(steps,id=randomUUID()){return{steps,request_id:id,allow_paid:true};}
test('foreign instructions and flags cannot add permissions or change endpoints',()=>{
  assert.deepEqual(inputFields({name:'Teste',approved:true,download_authorized:true,apiKey:'secret',endpoint:'https://evil.test',steps:['voz']}),{name:'Teste'});
  for(const url of ['https://youtube.com.evil.test/a','http://youtube.com/a','https://youtube.com@127.0.0.1/','https://127.0.0.1/?youtube.com','https://www.youtube.com:444/a','https://www.youtube.com\\@evil.test/a']) assert.throws(()=>officialUrl(url));
  assert.match(officialUrl('https://www.youtube.com/shorts/7CrZgPOR1BU'),/youtube.com/);
});
test('paid calls require server allowlist, verified email and per-run consent',async()=>{
  assert.equal(paidAllowed({id:'x',email:'a@b',email_confirmed:true},{}),false);
  assert.equal(paidAllowed({id:'x',email:'a@b',email_confirmed:false},{WORKFLOW_ALLOWED_EMAILS:'a@b'}),false);
  assert.equal(paidAllowed({id:'x',email:'a@b',email_confirmed:true},{WORKFLOW_ALLOWED_EMAILS:'a@b'}),true);
  const {engine,id,user}=setup({voz:async()=>{throw Error('must not call');}});
  await assert.rejects(engine.enqueue(id,user,{...request(['voz']),allow_paid:false}),{code:'PAID_DENIED'});
});
test('independent voice run never invokes unrelated stages; request replay does not charge',async()=>{
  let calls=0;const {engine,store,user,id}=setup({voz:async({input,markExternalStarted})=>{await markExternalStarted();calls++;assert.equal(input.script,'Já pronto.');return{data:{duration:1}};}},{script:'Já pronto.'});
  const req=request(['voz']);await engine.enqueue(id,user,req);await engine.enqueue(id,user,req);
  await engine.tick(id,user.id);await engine.enqueue(id,user,req);await engine.tick(id,user.id);
  assert.equal(calls,1);assert.equal(store.row.document.stages.find(s=>s.name==='voz').status,'ready');
  assert.equal(store.row.document.stages.find(s=>s.name==='roteiro').status,'pending');
});
test('dependencies execute in order and unrelated steps survive a failure',async()=>{
  const calls=[];const {engine,store,user,id}=setup({roteiro:async()=>{calls.push('roteiro');throw Error('bad');},voz:async()=>{calls.push('voz');return{data:{}};},frames:async()=>{calls.push('frames');return{data:{frames:[]}};}});
  await engine.enqueue(id,user,request(['roteiro','voz','frames']));
  for(let i=0;i<4;i++)await engine.tick(id,user.id);
  assert.deepEqual(calls,['roteiro','frames']);assert.equal(store.row.document.stages.find(s=>s.name==='voz').status,'waiting_input');
});
test('timeout after external start is unknown and never auto-retried',async()=>{
  let calls=0;const {engine,store,user,id}=setup({roteiro:async({markExternalStarted})=>{await markExternalStarted();calls++;throw Error('secret provider payload');}});
  await engine.enqueue(id,user,request(['roteiro']));await engine.tick(id,user.id);
  assert.equal(store.row.document.stages[0].status,'unknown');assert.doesNotMatch(JSON.stringify(publicJob(store.row)),/secret provider payload/);
  await assert.rejects(engine.enqueue(id,user,request(['roteiro'])),{code:'OUTCOME_UNKNOWN'});assert.equal(calls,1);
});
test('expired leases preserve uncertainty instead of retrying paid requests',()=>{
  const stages=initialStages();Object.assign(stages[0],{status:'running',lease_until:1,lease_id:'old',external_started:true});
  reconcile({input:{},stages},2);assert.equal(stages[0].status,'unknown');assert.equal(stages[0].lease_id,undefined);
});
test('editing one input invalidates only affected outputs and preserves artifacts',async()=>{
  const {engine,store,user,id}=setup({}, {script:'A',title:'Título'});
  for(const name of ['voz','titulos','frames']){const s=store.row.document.stages.find(x=>x.name===name);Object.assign(s,{status:'ready',input_hash:digest(stageInput(name,store.row.document.input,store.row.document.stages)),output:{data:{keep:'old'}}});}
  await engine.patch(id,user.id,{script:'B'});
  assert.equal(store.row.document.stages.find(s=>s.name==='voz').status,'stale');
  assert.equal(store.row.document.stages.find(s=>s.name==='frames').status,'ready');
  assert.deepEqual(store.row.document.stages.find(s=>s.name==='voz').output.data,{keep:'old'});
});
test('authentication verifies at provider and rejects anonymous users without exposing errors',async()=>{
  let effects=0,status;
  const res={status(n){status=n;return this;},json(value){assert.doesNotMatch(JSON.stringify(value),/private-secret/);}};
  const middleware=authenticate({fetchImpl:async()=>{effects++;throw Error('private-secret');}});
  await middleware({get:()=>undefined},res,()=>assert.fail());assert.equal(status,401);assert.equal(effects,0);
  await middleware({get:()=>`Bearer ${'a'.repeat(30)}`},res,()=>assert.fail());assert.equal(status,503);assert.equal(effects,1);
});
