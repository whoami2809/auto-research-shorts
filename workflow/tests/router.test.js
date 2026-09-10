'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {randomUUID}=require('node:crypto');
const {createRouter,dispatchRoute}=require('../router');
const {WorkflowError,initialStages}=require('../contracts');
const {SupabaseStore}=require('../store');

test('HTTP API checks ownership before access; candidate flags cannot invoke providers',async(t)=>{
  const owner=randomUUID(),id=randomUUID(),other=randomUUID();let enqueues=0;
  const row={id,owner_id:owner,created_at:new Date().toISOString(),version:0,document:{input:{name:'Teste'},stages:initialStages(),artifacts:[],requests:[]}};
  const store={ready:true,list:async()=>[row],get:async(job,user)=>{if(job!==id||user!==owner)throw new WorkflowError('NOT_FOUND','Projeto não encontrado.',404);return structuredClone(row);},mutate:async(job,user,fn)=>{const r=await store.get(job,user);const result=fn(r.document);return{row:r,result};}};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.workflowUser={id:req.get('x-test-owner')||owner};next();});
  app.use('/api/workflow',createRouter({store,engine:{enqueue:async()=>{enqueues++;throw new WorkflowError('PAID_DENIED','Negado.',403);}},env:{}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/workflow`;
  assert.equal((await fetch(base+'/jobs/'+id)).status,200);
  assert.equal((await fetch(base+'/jobs/'+id,{headers:{'x-test-owner':other}})).status,404);
  assert.equal((await fetch(base+'/jobs/'+other+'/artifacts/'+randomUUID())).status,404);
  const res=await fetch(base+'/jobs/'+id+'/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({steps:['voz'],approved:true,allow_paid:false,request_id:randomUUID()})});
  assert.equal(res.status,403);assert.equal(enqueues,1);
});
test('project deletion is routed through the owner-scoped store',async(t)=>{
  const owner=randomUUID(),id=randomUUID();let deleted;
  const store={ready:true,list:async()=>[],delete:async(user,job)=>{deleted={user,job};}};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.workflowUser={id:owner};next();});
  app.use('/api/workflow',createRouter({store,engine:{enqueue:async()=>{}}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/workflow`;
  const response=await fetch(base+'/jobs/'+id,{method:'DELETE'});
  assert.equal(response.status,204);assert.deepEqual(deleted,{user:owner,job:id});
});
test('dispatch requires a valid scoped capability before any queue effect',async()=>{
  let lookups=0,effects=0,status;
  const handler=dispatchRoute({store:{findDispatch:async()=>{lookups++;return null;}},engine:{tick:async()=>{effects++;}}});
  const res={status(n){status=n;return this;},json(){}};
  await handler({get:()=>undefined,params:{id:randomUUID()}},res);assert.equal(status,403);assert.equal(lookups,0);
  await handler({get:()=>'a'.repeat(64),params:{id:randomUUID()}},res);assert.equal(status,403);assert.equal(lookups,1);assert.equal(effects,0);
});
test('persistent store narrows owner and rejects cross-request CAS conflicts',async()=>{
  const owner=randomUUID(),id=randomUUID();let calls=0;
  const row={id,owner_id:owner,version:3,document:{counter:0}};
  const store=new SupabaseStore({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-only-service-key'},fetchImpl:async(url,options)=>{
    const u=new URL(url);assert.equal(u.searchParams.get('owner_id'),'eq.'+owner);
    assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer test-only-service-key');
    calls++;
    if(options.method==='PATCH'){assert.equal(u.searchParams.get('version'),'eq.3');return Response.json(calls===2?[]:[{...row,...JSON.parse(options.body)}]);}
    return Response.json([row]);
  }});
  const saved=await store.mutate(id,owner,doc=>{doc.counter++;});assert.equal(saved.row.document.counter,1);assert.equal(saved.row.version,4);assert.equal(calls,4);
});
test('storage failures never leak provider body, URL token or service key',async()=>{
  const store=new SupabaseStore({env:{SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-private-key'},fetchImpl:async()=>new Response('test-private-key',{status:500})});
  await assert.rejects(store.get(randomUUID(),randomUUID()),e=>e.code==='STORAGE_UNAVAILABLE'&&!e.message.includes('test-private-key'));
});

test('import route stores canonical bytes returned by validation',async(t)=>{
  const owner=randomUUID(),id=randomUUID();const original=Buffer.from('uploaded-file-bytes');const canonical=Buffer.from('canonical-copy-bytes');
  const row={id,owner_id:owner,created_at:new Date().toISOString(),version:0,document:{input:{name:'Teste',base_artifact:null},stages:initialStages(),artifacts:[],requests:[]}};
  let persisted;
  const store={
    ready:true,
    get:async()=>structuredClone(row),
    mutate:async()=>({row:{...row},result:undefined}),
    put:async(_owner,_job,stage,_revision,file)=>{
      persisted={...file};
      return {id:randomUUID(),name:file.name,mime:file.mime,size:file.bytes.length,stage,path:`${_owner}/${_job}/${stage}/1/${randomUUID()}.bin`};
    }
  };
  store.mutate=async(id_,owner_,fn)=>{
    if(id_!==id||owner_!==owner) throw new WorkflowError('NOT_FOUND','Projeto não encontrado.',404);
    const current=await store.get();
    fn(current.document);
    return {row:current};
  };
  const app=express();app.use((req,res,next)=>{req.workflowUser={id:owner,email_confirmed:true,email:'tester@example.com'};next();});
  app.use('/api/workflow',createRouter({store,engine:{enqueue:async()=>({})},validateImport:async(_ctx,file)=>{file.bytes=canonical;return {duration:1};},env:{WORKFLOW_ALLOWED_USER_IDS:owner}}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/workflow`;
  const res=await fetch(base+'/jobs/'+id+'/import?kind=base',{method:'POST',headers:{'content-type':'video/mp4','Authorization':'Bearer token'},body:original});
  assert.equal(res.status,201);
  assert.ok(persisted);assert.equal(persisted.bytes.toString(),canonical.toString());
});
