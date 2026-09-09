'use strict';

const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const {fail} = require('./contracts');
const MAX_BYTES = 250 * 1024 * 1024;

// Conservative global-unicast subset. Reject IPv6 (including mapped IPv4) until
// a maintained special-purpose IPv6 registry is integrated. Fail closed.
function isPublicIP(address) {
  if (net.isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
function secureURL(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\s\x00-\x1f]/.test(value)) fail('NETWORK_DENIED','URL de mídia inválida.');
  let url; try { url = new URL(value); } catch { fail('NETWORK_DENIED','URL de mídia inválida.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || net.isIP(url.hostname.replace(/[\[\]]/g,''))) fail('NETWORK_DENIED','Somente HTTPS sem credenciais, IP literal ou porta alternativa.');
  return url;
}
function aborted(signal) {
  if (signal?.aborted) fail('ABORTED','Operação cancelada.');
}
async function boundedBody(response, {signal, maxBytes=MAX_BYTES}={}) {
  aborted(signal);
  if (!response?.ok || !response.body?.getReader) fail('MEDIA_INVALID','Resposta de armazenamento inválida.');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length)>maxBytes)) {
    await response.body.cancel(); fail('MEDIA_LIMIT','Arquivo excede o limite.');
  }
  const reader=response.body.getReader(), chunks=[]; let size=0;
  const cancel=()=>{ reader.cancel().catch(()=>{}); };
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    while (true) {
      aborted(signal);
      const {done,value}=await reader.read();
      aborted(signal);
      if(done) break;
      size+=value.byteLength;
      if(size>maxBytes) fail('MEDIA_LIMIT','Arquivo excede o limite.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks,size);
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); signal?.removeEventListener('abort',cancel); }
}

// Server-only capability; never construct verifyDestination from candidate
// metadata, an approved flag or an allowlist. It must check exact URL, origin,
// publication relationship and authorization for EACH hop. This primitive is
// not a platform extractor, antivirus scanner, or complete download approval.
function createPinnedTransport({verifyDestination,lookup=dns.lookup,request=https.request}={}) {
  return async function transfer(value,{signal,maxBytes=MAX_BYTES}={}) {
    if(typeof verifyDestination!=='function') fail('CONFIG_MISSING','Verificador confiável de publicação/CDN ausente.',503);
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MAX_BYTES) fail('MEDIA_LIMIT','Limite inválido.');
    const controller=new AbortController();
    const cancel=()=>controller.abort();
    const timer=setTimeout(cancel,120000);
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted) cancel();
    // Race also bounds an unresponsive DNS resolver / authorization service.
    const bounded=promise=>new Promise((resolve,reject)=>{
      const stop=()=>reject(Object.assign(new Error('Operação cancelada.'),{code:'ABORTED'}));
      controller.signal.addEventListener('abort',stop,{once:true});
      Promise.resolve(promise).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));
      if(controller.signal.aborted) stop();
    });
    try {
      let current=secureURL(value), previous=null;
      for(let hop=0;hop<=4;hop++) {
        aborted(controller.signal);
        const proof=await bounded(verifyDestination({url:current.href,origin:current.origin,previous}));
        if(!proof || proof.url!==current.href || proof.origin!==current.origin || proof.authorized!==true || proof.publicationBound!==true) fail('NETWORK_DENIED','Destino sem vínculo verificado à publicação autorizada.');
        const records=await bounded(lookup(current.hostname,{all:true,verbatim:true}));
        if(!records.length || records.some(r=>!isPublicIP(r.address))) fail('NETWORK_DENIED','DNS contém endereço não público ou não suportado.');
        const pinned=records[0];
        const result=await bounded(new Promise((resolve,reject)=>{
          const req=request(current,{
            method:'GET',agent:false,signal:controller.signal,servername:current.hostname,rejectUnauthorized:true,
            headers:{Accept:'video/mp4','Accept-Encoding':'identity'},
            lookup:(_host,options,callback)=>callback(null,options?.all?[{address:pinned.address,family:4}]:pinned.address,4)
          },res=>{
            if([301,302,303,307,308].includes(res.statusCode)) {
              const location=res.headers.location;res.destroy();
              if(!location) return reject(Object.assign(new Error('Redirecionamento inválido.'),{code:'NETWORK_DENIED'}));
              return resolve({location});
            }
            if(res.statusCode!==200 || (res.headers['content-encoding'] && res.headers['content-encoding']!=='identity')) {
              res.destroy();return reject(Object.assign(new Error('Resposta de mídia inválida.'),{code:'NETWORK_DENIED'}));
            }
            if(Number(res.headers['content-length'])>maxBytes) {res.destroy();return reject(Object.assign(new Error('Arquivo excede limite.'),{code:'MEDIA_LIMIT'}));}
            const chunks=[];let size=0;
            res.on('data',chunk=>{
              size+=chunk.length;
              if(size>maxBytes) {res.destroy();reject(Object.assign(new Error('Arquivo excede limite.'),{code:'MEDIA_LIMIT'}));}
              else chunks.push(chunk);
            });
            res.on('error',reject);res.on('aborted',()=>reject(Object.assign(new Error('Transferência interrompida.'),{code:'NETWORK_DENIED'})));
            res.on('end',()=>resolve({bytes:Buffer.concat(chunks),url:current.href}));
          });
          req.on('error',reject);req.end();
        }));
        if(!result.location) return result;
        previous=current.href;
        current=secureURL(new URL(result.location,current).href);
      }
      fail('NETWORK_DENIED','Limite de redirecionamentos excedido.');
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
  };
}
module.exports={MAX_BYTES,isPublicIP,secureURL,boundedBody,createPinnedTransport};
