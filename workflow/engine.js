'use strict';

const {randomUUID} = require('node:crypto');
const {STAGES,PAID,DEPENDENCIES,fail,uuid,digest,stageInput} = require('./contracts');
const LEASE_MS=180000;
const terminal = s => !['queued','running'].includes(s.status);
function reconcile(doc,now=Date.now()) {
  for(const s of doc.stages) {
    if(s.status==='running' && s.lease_until<=now) {
      s.status=s.external_started?'unknown':'failed';
      s.message=s.external_started?'Resultado externo incerto. Confira o provedor antes de autorizar nova execução.':'Execução interrompida. Pode tentar novamente.';
      delete s.lease_id;
    }
    if(s.status==='ready' && s.input_hash!==digest(stageInput(s.name,doc.input,doc.stages))) {
      s.status='stale';s.message='A entrada mudou. A saída anterior foi preservada; execute esta etapa se desejar atualizar.';
    }
  }
}
class Engine {
  constructor({store,providers,now=Date.now,paidAllowed=()=>false}) { Object.assign(this,{store,providers,now,paidAllowed}); }
  async patch(id,owner,patch) {
    return this.store.mutate(id,owner,doc=>{
      if(doc.stages.some(s=>['queued','running'].includes(s.status))) fail('BUSY','Aguarde as etapas ativas terminarem antes de editar as entradas.',409);
      doc.input={...doc.input,...patch};reconcile(doc,this.now());
    });
  }
  async enqueue(id,user,body) {
    if(!uuid(body.request_id)) fail('REQUEST_INVALID','Identificador de execução inválido.');
    if(!Array.isArray(body.steps)||!body.steps.length||body.steps.some(s=>!STAGES.includes(s))) fail('STAGE_INVALID','Escolha etapas válidas.');
    const steps=[...new Set(body.steps)];
    if(steps.some(s=>PAID.has(s)) && (body.allow_paid!==true||!this.paidAllowed(user))) fail('PAID_DENIED','A execução paga exige consentimento e uma conta autorizada no servidor.',403);
    return this.store.mutate(id,user.id,doc=>{
      if(doc.requests.includes(body.request_id)) return {unchanged:true,value:'duplicate'};
      reconcile(doc,this.now());
      if(doc.stages.some(s=>['queued','running'].includes(s.status))) fail('BUSY','Este projeto já tem uma execução ativa.',409);
      if(doc.stages.some(s=>steps.includes(s.name)&&s.status==='unknown')) fail('OUTCOME_UNKNOWN','Confira a cobrança e o resultado no provedor antes de tentar novamente. O resultado incerto não é repetido automaticamente.',409);
      for(const name of steps) {
        const s=doc.stages.find(s=>s.name===name);
        if(s.status==='ready') continue;
        if(!this.providers[name]) { s.status='waiting_input';s.message='Esta etapa ainda não possui um executor configurado.';continue; }
        s.status='queued';s.request_id=body.request_id;s.external_started=false;s.revision++;
        s.selected_steps=steps;s.message='Na fila.';
        s.allow_frame_upload=body.allow_frame_upload===true;
      }
      doc.requests=[...doc.requests.slice(-99),body.request_id];
    });
  }
  async tick(id,owner) {
    const claimed = await this.store.mutate(id,owner,doc=>{
      reconcile(doc,this.now());
      // Two independent steps may execute concurrently. Dependency failure never blocks unrelated work.
      if(doc.stages.filter(s=>s.status==='running').length>=2) return {unchanged:true,value:null};
      for(const s of doc.stages.filter(s=>s.status==='queued')) {
        const names=s.name==='organizar'?s.selected_steps.filter(n=>n!=='organizar'):DEPENDENCIES[s.name].filter(n=>s.selected_steps.includes(n));
        const deps=doc.stages.filter(d=>names.includes(d.name));
        if(deps.some(d=>['queued','running'].includes(d.status))) continue;
        if(deps.some(d=>d.status!=='ready')) {s.status='waiting_input';s.message='Uma etapa necessária precisa de atenção.';continue;}
        s.status='running';s.lease_id=randomUUID();s.lease_until=this.now()+LEASE_MS;
        s.input_hash=digest(stageInput(s.name,doc.input,doc.stages));s.message='Executando.';
        return {stage:structuredClone(s),input:stageInput(s.name,doc.input,doc.stages),outputs:Object.fromEntries(doc.stages.filter(x=>x.status==='ready').map(x=>[x.name,x.output]))};
      }
      return null;
    });
    const task=claimed.result;
    if(!task) return {active:claimed.row.document.stages.some(s=>!terminal(s))};
    const {stage,input,outputs}=task;
    let externalStarted=false;
    const markExternalStarted=async()=>{
      await this.store.mutate(id,owner,doc=>{
        const s=doc.stages.find(s=>s.name===stage.name);
        if(s.status!=='running'||s.lease_id!==stage.lease_id||s.lease_until<=this.now()) fail('LEASE_LOST','A execução perdeu sua reserva.',409);
        s.external_started=true;s.lease_until=this.now()+LEASE_MS;
      });
      externalStarted=true;
    };
    try {
      const output=await this.providers[stage.name]({input,outputs,signal:AbortSignal.timeout(120000),markExternalStarted,jobId:id,ownerId:owner,allowFrameUpload:stage.allow_frame_upload});
      if(!output||!output.data||JSON.stringify(output.data).length>200000) fail('OUTPUT_INVALID','Resultado da etapa inválido.');
      const artifacts=[];
      if(output.files && (!Array.isArray(output.files)||output.files.length>80)) fail('OUTPUT_INVALID','Quantidade de arquivos excedida.');
      for(const file of output.files||[]) {
        await this.store.mutate(id,owner,doc=>{
          const s=doc.stages.find(s=>s.name===stage.name);
          if(s.lease_id!==stage.lease_id||s.status!=='running'||s.lease_until<=this.now())fail('LEASE_LOST','A execução perdeu sua reserva.',409);
          s.lease_until=this.now()+LEASE_MS;
        });
        artifacts.push(await this.store.put(owner,id,stage.name,stage.revision,file));
      }
      await this.store.mutate(id,owner,doc=>{
        const s=doc.stages.find(s=>s.name===stage.name);
        if(s.lease_id!==stage.lease_id||s.status!=='running'||s.lease_until<=this.now()) fail('LEASE_LOST','A execução perdeu sua reserva.',409);
        s.status='ready';s.output={data:output.data,artifact_ids:artifacts.map(a=>a.id)};
        s.message='Concluída.';s.completed_at=new Date(this.now()).toISOString();delete s.lease_id;delete s.lease_until;
        doc.artifacts.push(...artifacts);
      });
    } catch(error) {
      await this.store.mutate(id,owner,doc=>{
        const s=doc.stages.find(s=>s.name===stage.name);
        if(s.lease_id!==stage.lease_id) return {unchanged:true,value:null};
        const unknown=error?.code!=='EXTERNAL_REJECTED'&&(externalStarted||s.external_started||error?.code==='EXTERNAL_OUTCOME_UNKNOWN');
        s.status=unknown?'unknown':error?.code==='INPUT_REQUIRED'?'waiting_input':'failed';
        const messages={CONFIG_MISSING:'Configuração desta etapa ausente no servidor.',INPUT_REQUIRED:'Forneça os dados necessários para esta etapa.',NETWORK_DENIED:'O destino de rede não passou pela política de segurança.'};
        s.message=unknown?'Resultado externo incerto. Não haverá repetição automática.':messages[error?.code]||'Não foi possível concluir esta etapa. As outras foram preservadas.';
        if(error?.code==='INPUT_REQUIRED'&&error.data&&JSON.stringify(error.data).length<100000)s.output={data:error.data,artifact_ids:[]};
        delete s.lease_id;delete s.lease_until;
      });
    }
    const row=await this.store.get(id,owner);
    return {active:row.document.stages.some(s=>!terminal(s))};
  }
}
module.exports={Engine,reconcile,LEASE_MS};
