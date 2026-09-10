'use strict';

const express=require('express');
const {Readable}=require('node:stream');
const {createHash,randomBytes}=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {STAGES,PAID,WorkflowError,fail,inputFields,publicJob,uuid,digest,stageInput}=require('./contracts');
const {paidAllowed}=require('./auth');
const {reconcile}=require('./engine');
const LABELS={roteiro:'Roteiro',titulos:'Títulos',seo:'Descrição e SEO',voz:'Narração ElevenLabs',frames:'Extração de frames',busca:'Pesquisa de originais',downloads:'Vídeos e créditos',organizar:'Pacote ZIP'};
function createRouter({store,engine,validateImport,env=process.env}) {
  const router=express.Router();
  router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
  const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
  router.get('/capabilities',route(async(req,res)=>{
    res.json({storageReady:store.ready,stages:STAGES.map(name=>{
      let reason='';
      if(!store.ready) reason='Configure a persistência no servidor.';
      else if(PAID.has(name)&&!paidAllowed(req.workflowUser,env)) reason='Conta ainda não autorizada para chamadas pagas.';
      else if(name==='voz'&&!env.ELEVENLABS_API_KEY) reason='ElevenLabs ainda não configurada.';
      else if(['roteiro','titulos','seo'].includes(name)&&!((env.GEMINI_API_KEY&&(env.GEMINI_MODELS||env.GEMINI_MODEL))||(env.ANTHROPIC_API_KEY&&env.ANTHROPIC_MODEL))) reason='IA editorial ainda não configurada.';
      else if(name==='frames'&&(!env.WF_FFMPEG_PATH||!env.WF_FFPROBE_PATH)) reason='Processador de frames ainda não configurado.';
      else if(name==='downloads') reason='Download automático aguarda validação do transporte e da quarentena em produção.';
      else if(name==='busca') reason='Modo assistido: frames para Lens e links dos candidatos.';
      return {name,label:LABELS[name],available:!reason||(store.ready&&name==='busca'),reason};
    })});
  }));
  router.get('/jobs',route(async(req,res)=>{
    const rows=await store.list(req.workflowUser.id);
    res.json({jobs:rows.map(row=>({...publicJob(row).job,stages:publicJob(row).stages}))});
  }));
  router.post('/jobs',route(async(req,res)=>{
    const existing=await store.list(req.workflowUser.id);
    if(existing.length>=50) fail('JOB_LIMIT','Limite de 50 projetos atingido. Contate o responsável para ampliar.',409);
    const row=await store.create(req.workflowUser.id,inputFields(req.body));
    res.status(201).json(publicJob(row));
  }));
  router.delete('/jobs/:id',route(async(req,res)=>{
    await store.delete(req.workflowUser.id, req.params.id);
    res.status(204).end();
  }));
  router.patch('/jobs/:id/order',route(async(req,res)=>{
    const rows = await store.reorder(req.workflowUser.id, req.params.id, req.body?.direction, req.body?.target_id);
    res.json({jobs: rows.map(row => publicJob(row).job)});
  }));
  router.get('/jobs/:id',route(async(req,res)=>{
    const result=await store.mutate(req.params.id,req.workflowUser.id,doc=>{const before=JSON.stringify(doc.stages);reconcile(doc);if(before===JSON.stringify(doc.stages))return {unchanged:true,value:null};});
    res.json(publicJob(result.row));
  }));
  router.patch('/jobs/:id',route(async(req,res)=>{
    const result=await engine.patch(req.params.id,req.workflowUser.id,inputFields(req.body,true));
    res.json(publicJob(result.row));
  }));
  router.post('/jobs/:id/import',async(req,res,next)=>{
    try {
      if(!paidAllowed(req.workflowUser,env)) fail('ACCESS_DENIED','A importação requer conta autorizada no servidor.',403);
      await store.get(req.params.id,req.workflowUser.id);
      if(!['base','voice'].includes(req.query.kind)) fail('INPUT_INVALID','Escolha vídeo-base ou voz.');
      const mime=req.get('content-type');
      if(req.query.kind==='base'?mime!=='video/mp4':!['audio/mpeg','audio/wav'].includes(mime)) fail('INPUT_INVALID','Formato de mídia inválido.');
      next();
    }catch(e){next(e);}
  },express.raw({type:['video/mp4','audio/mpeg','audio/wav'],limit:'50mb'}),route(async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!req.body.length) fail('INPUT_INVALID','Arquivo vazio ou inválido.');
    if(typeof validateImport!=='function') fail('CONFIG_MISSING','Validação de mídia indisponível.',503);
    const owner=req.workflowUser.id,id=req.params.id,kind=req.query.kind;
    const row=await store.get(id,owner);
    if(row.document.stages.some(s=>['running','queued'].includes(s.status))) fail('BUSY','Aguarde a execução terminar antes de importar.',409);
    if(kind==='base'&&row.document.input.base_artifact) fail('BASE_EXISTS','Crie um novo projeto para outro vídeo-base.',409);
    if(kind==='voice'&&row.document.stages.find(s=>s.name==='voz').status==='ready') fail('VOICE_EXISTS','A narração pronta foi preservada. Use outro projeto para substituí-la.',409);
    const mime=req.get('content-type'),name=kind==='base'?'base.mp4':mime==='audio/wav'?'narracao.wav':'narracao.mp3';
    const context={jobId:id,ownerId:owner,input:row.document.input,outputs:{},signal:AbortSignal.timeout(120000)};
    const artifactPayload={name,mime,bytes:req.body};
    const info=await validateImport(context,artifactPayload);
    if(!Buffer.isBuffer(artifactPayload.bytes)||artifactPayload.bytes.length>250*1024*1024) fail('MEDIA_INVALID','Falha ao validar o arquivo importado.');
    const stage=kind==='base'?'base':'voz',revision=kind==='base'?1:row.document.stages.find(s=>s.name==='voz').revision+1;
    const artifact=await store.put(owner,id,stage,revision,artifactPayload);
    const saved=await store.mutate(id,owner,doc=>{
      if(doc.stages.some(s=>['running','queued'].includes(s.status))||(kind==='base'&&doc.input.base_artifact)) fail('CONFLICT','O projeto mudou durante a importação.',409);
      if(kind==='voice'&&doc.stages.find(s=>s.name==='voz').status==='ready') fail('CONFLICT','Uma narração pronta já foi preservada.',409);
      doc.artifacts.push(artifact);
      if(kind==='base')doc.input.base_artifact=artifact.id;
      else {const s=doc.stages.find(s=>s.name==='voz');Object.assign(s,{status:'ready',revision,input_hash:digest(stageInput('voz',doc.input,doc.stages)),output:{data:{...info,provided_by_user:true},artifact_ids:[artifact.id]},message:'Narração fornecida e validada; sem chamada paga.'});}
      reconcile(doc);
    });
    res.status(201).json(publicJob(saved.row));
  }));
  const run=route(async(req,res)=>{
    const steps=req.params.stage?[req.params.stage]:req.body.steps;
    const result=await engine.enqueue(req.params.id,req.workflowUser,{...req.body,steps});
    // A short-lived capability can only advance already authorized steps of this one job.
    // It contains no user JWT, credentials, input text, URL, or permission to enqueue new work.
    const token=randomBytes(32).toString('hex');
    const hash=createHash('sha256').update(token).digest('hex');
    const dispatchRow=await store.setDispatch(req.params.id,req.workflowUser.id,hash,token,req.body.request_id);
    const response=publicJob(result.row);
    res.status(202).json({...response,dispatch:{jobId:req.params.id,requestId:req.body.request_id,token:dispatchRow.dispatch_token}});
  });
  router.post('/jobs/:id/run',run);
  router.post('/jobs/:id/stages/:stage/run',run);
  router.get('/jobs/:id/artifacts/:artifactId',route(async(req,res)=>{
    const row=await store.get(req.params.id,req.workflowUser.id);
    const artifact=row.document.artifacts.find(a=>a.id===req.params.artifactId);
    if(!artifact) fail('NOT_FOUND','Arquivo não encontrado.',404);
    const response=await store.download(artifact);
    res.set({'Content-Type':artifact.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,'X-Content-Type-Options':'nosniff'});
    await pipeline(Readable.fromWeb(response.body),res);
  }));
  router.post('/jobs/:id/lens/:artifactId',route(async(req,res)=>{
    const row=await store.get(req.params.id,req.workflowUser.id);
    const artifact=row.document.artifacts.find(a=>a.id===req.params.artifactId);
    if(!artifact) fail('NOT_FOUND','Frame não encontrado.',404);
    res.json(await store.signedFrame(artifact));
  }));
  router.use((err,req,res,next)=>{
    if(res.headersSent) return next(err);
    res.status(err instanceof WorkflowError?err.status:500).json({error:err instanceof WorkflowError?err.message:'Erro interno. Nenhuma etapa concluída foi descartada.',code:err instanceof WorkflowError?err.code:'INTERNAL_ERROR'});
  });
  return router;
}
function dispatchRoute({store,engine}) {
  return async(req,res)=>{
    try {
      const token=req.get('x-workflow-dispatch');
      if(typeof token!=='string'||! /^[a-f0-9]{64}$/.test(token)||!uuid(req.params.id)) return res.status(403).json({error:'Não autorizado.'});
      const hash=createHash('sha256').update(token).digest('hex');
      const row=await store.findDispatch(req.params.id,hash);
      if(!row) return res.status(403).json({error:'Autorização expirada.'});
      const result=await engine.tick(row.id,row.owner_id);
      res.json(result);
    } catch {res.status(503).json({error:'Execução temporariamente indisponível.'});}
  };
}
module.exports={createRouter,dispatchRoute};
