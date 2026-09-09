'use strict';

const { createHash } = require('node:crypto');
const STAGES = Object.freeze(['roteiro', 'titulos', 'seo', 'voz', 'frames', 'busca', 'downloads', 'organizar']);
const PAID = new Set(['roteiro', 'titulos', 'seo', 'voz']);
const DEPENDENCIES = Object.freeze({roteiro: [], titulos: ['roteiro'], seo: ['roteiro', 'titulos'], voz: ['roteiro'], frames: [], busca: ['frames'], downloads: ['busca'], organizar: []});
class WorkflowError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function fail(code, message, status) { throw new WorkflowError(code, message, status); }
function uuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function officialUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\s]/.test(value)) fail('URL_INVALID', 'Link inválido.');
  let url; try { url = new URL(value); } catch { fail('URL_INVALID', 'Link inválido.'); }
  const hosts = ['youtube.com','www.youtube.com','m.youtube.com','youtu.be','tiktok.com','www.tiktok.com','vm.tiktok.com','vt.tiktok.com','instagram.com','www.instagram.com','facebook.com','www.facebook.com','m.facebook.com','fb.watch'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) fail('URL_DENIED', 'Use links HTTPS oficiais de YouTube, TikTok, Instagram ou Facebook.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('utm_') || ['igsh','fbclid','si'].includes(key)) url.searchParams.delete(key);
  return url.href;
}
function inputFields(body, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INPUT_INVALID', 'Entrada inválida.');
  const result = {};
  const limits = {name:120, transcript:20000, script:20000, title:180, channel:80};
  for (const [key, max] of Object.entries(limits)) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || body[key].length > max || /\x00/.test(body[key])) fail('INPUT_INVALID', `Campo ${key} inválido ou muito longo.`);
      result[key] = body[key].trim();
    }
  }
  if (!partial && !result.name) result.name = 'Novo vídeo';
  if (body.base_url !== undefined) result.base_url = body.base_url ? officialUrl(body.base_url) : '';
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > 25) fail('LINK_LIMIT', 'Envie até 25 links por projeto.');
    result.links = [...new Set(body.links.map(officialUrl))];
  }
  if (body.operation !== undefined) {
    if (!['traduzir','formatar','remodelar','traduzir_remodelar'].includes(body.operation)) fail('INPUT_INVALID','Operação editorial inválida.');
    result.operation = body.operation;
  }
  // Ignore unknown fields: data cannot provide permissions, endpoints, paths or secrets.
  return result;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function stageInput(name, input, stages) {
  const output = n => stages.find(s => s.name === n && s.status === 'ready')?.output?.data;
  const script = input.script || output('roteiro')?.script || '';
  const title = input.title || output('titulos')?.title || '';
  switch (name) {
    case 'roteiro': return {transcript: input.transcript || '', operation: input.operation || 'traduzir', channel: input.channel || ''};
    case 'titulos': return {script, channel: input.channel || ''};
    case 'seo': return {script,title,channel:input.channel || ''};
    case 'voz': return {script};
    case 'frames': return {base_url: input.base_url || '', base_artifact: input.base_artifact || null};
    case 'busca': return {frames: output('frames') || null, links: input.links || []};
    case 'downloads': return {links: input.links || [], base_url: input.base_url || ''};
    case 'organizar': return {script,title,outputs:stages.filter(s=>s.status==='ready' && s.name!=='organizar').map(s=>({name:s.name,revision:s.revision,output:s.output}))};
    default: fail('STAGE_INVALID','Etapa inexistente.');
  }
}
function initialStages() { return STAGES.map(name => ({name,status:'pending',revision:0,message:'Não executada.',output:null})); }
function publicJob(row) {
  const stages = row.document.stages.map(({lease_id,lease_until,external_started,input_hash,request_id,...s})=>s);
  return {job:{id:row.id,name:row.document.input.name,created_at:row.created_at,version:row.version,...row.document.input},stages,artifacts:row.document.artifacts.map(({path,...a})=>a)};
}
module.exports = {STAGES,PAID,DEPENDENCIES,WorkflowError,fail,uuid,officialUrl,inputFields,digest,stageInput,initialStages,publicJob};
