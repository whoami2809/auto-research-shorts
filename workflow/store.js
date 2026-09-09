'use strict';

const {randomUUID} = require('node:crypto');
const {WorkflowError, initialStages, fail, uuid} = require('./contracts');
const TABLE = 'shorts_workflow_jobs';
const BUCKET = 'shorts-workflow';
class SupabaseStore {
  constructor({env=process.env,fetchImpl=fetch}={}) {
    this.url = env.SUPABASE_URL || '';
    this.key = env.SUPABASE_SERVICE_ROLE_KEY || '';
    this.fetch = fetchImpl;
  }
  get ready() { return /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(this.url) && !!this.key; }
  headers(extra={}) { return {apikey:this.key,Authorization:`Bearer ${this.key}`,...extra}; }
  async request(path, options={}) {
    if (!this.ready) fail('CONFIG_MISSING','Persistência do workflow não configurada no servidor.',503);
    let response;
    try { response = await this.fetch(this.url+path,{...options,headers:this.headers(options.headers),redirect:'error',signal:AbortSignal.timeout(15000)}); }
    catch { fail('STORAGE_UNAVAILABLE','Armazenamento temporariamente indisponível.',503); }
    if (!response.ok) fail('STORAGE_UNAVAILABLE','Não foi possível acessar o armazenamento do workflow.',503);
    return response;
  }
  async rows(query) { return (await this.request(`/rest/v1/${TABLE}?${query}`)).json(); }
  async list(owner) { return this.rows(`owner_id=eq.${owner}&select=id,owner_id,created_at,version,document&order=created_at.desc&limit=50`); }
  async get(id,owner) {
    if (!uuid(id) || !uuid(owner)) fail('NOT_FOUND','Projeto não encontrado.',404);
    const rows = await this.rows(`id=eq.${id}&owner_id=eq.${owner}&select=*`);
    if (!rows[0]) fail('NOT_FOUND','Projeto não encontrado.',404);
    return rows[0];
  }
  async create(owner,input) {
    if (!uuid(owner)) fail('AUTH_INVALID','Sessão inválida.',401);
    const row = {id:randomUUID(),owner_id:owner,document:{input,stages:initialStages(),artifacts:[],requests:[]}};
    const response = await this.request(`/rest/v1/${TABLE}`,{method:'POST',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify(row)});
    return (await response.json())[0];
  }
  async setDispatch(id,owner,hash,token,requestId) {
    if(!uuid(id)||!uuid(owner)||!uuid(requestId)||! /^[a-f0-9]{64}$/.test(hash)) fail('DISPATCH_INVALID','Despacho inválido.');
    const response=await this.request(`/rest/v1/${TABLE}?id=eq.${id}&owner_id=eq.${owner}&or=(dispatch_request.is.null,dispatch_request.neq.${requestId})`,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({dispatch_hash:hash,dispatch_token:token,dispatch_request:requestId,dispatch_expires_at:new Date(Date.now()+3600000).toISOString()})});
    const saved=await response.json();
    return saved[0]||(await this.get(id,owner));
  }
  async findDispatch(id,hash) {
    const rows=await this.rows(`id=eq.${id}&dispatch_hash=eq.${hash}&dispatch_expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=*`);
    return rows[0];
  }
  async mutate(id,owner,fn) {
    // Compare-and-swap serializes across all Render instances. No in-memory lock is authoritative.
    for (let attempt=0;attempt<8;attempt++) {
      const row = await this.get(id,owner);
      const result = fn(row.document,row);
      if (result?.unchanged) return {row,result:result.value};
      const response = await this.request(`/rest/v1/${TABLE}?id=eq.${id}&owner_id=eq.${owner}&version=eq.${row.version}`,{method:'PATCH',headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({document:row.document,version:row.version+1,updated_at:new Date().toISOString()})});
      const saved = await response.json();
      if (saved.length) return {row:saved[0],result};
    }
    throw new WorkflowError('CONFLICT','O projeto foi atualizado em outra execução. Tente novamente.',409);
  }
  async put(owner,job,stage,revision,file) {
    if (!uuid(owner)||!uuid(job)||!Buffer.isBuffer(file.bytes)||file.bytes.length>250*1024*1024) fail('ARTIFACT_INVALID','Arquivo de entrega inválido.');
    const allowed = {'audio/mpeg':'mp3','audio/wav':'wav','image/png':'png','image/jpeg':'jpg','video/mp4':'mp4','text/plain':'txt','application/zip':'zip'};
    if (!allowed[file.mime]) fail('ARTIFACT_INVALID','Formato de entrega não permitido.');
    const id = randomUUID();
    const objectPath = `${owner}/${job}/${stage}/${revision}/${id}.${allowed[file.mime]}`;
    await this.request(`/storage/v1/object/${BUCKET}/${objectPath}`,{method:'POST',headers:{'Content-Type':file.mime,'x-upsert':'false'},body:file.bytes});
    return {id,path:objectPath,name:String(file.name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0,160),mime:file.mime,size:file.bytes.length,stage,revision};
  }
  async download(artifact) {
    const response = await this.request(`/storage/v1/object/authenticated/${BUCKET}/${artifact.path}`);
    return response;
  }
  async signedFrame(artifact) {
    if (!['image/png','image/jpeg'].includes(artifact.mime)||artifact.stage!=='frames') fail('UPLOAD_DENIED','Somente frames extraídos deste projeto podem ir ao Lens.',403);
    const response = await this.request(`/storage/v1/object/sign/${BUCKET}/${artifact.path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:900})});
    const data = await response.json();
    if (typeof data.signedURL !== 'string' || !data.signedURL.startsWith(`/object/sign/${BUCKET}/`)) fail('STORAGE_INVALID','Resposta de armazenamento inválida.',502);
    const imageUrl=this.url+'/storage/v1'+data.signedURL;
    return {url:'https://lens.google.com/uploadbyurl?url='+encodeURIComponent(imageUrl),expires_at:new Date(Date.now()+900000).toISOString()};
  }
}
module.exports={SupabaseStore,BUCKET,TABLE};
