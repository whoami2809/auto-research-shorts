'use strict';

// Extensão exclusiva do downloader do app. Não libera etapas do workflow.
const {officialUrl}=require('./contracts');
const {secureURL,isPublicIP}=require('./network');
const dns=require('node:dns').promises;
const https=require('node:https');
const SITES=Object.freeze({
  xiaohongshu:{hosts:['xhslink.cn','xiaohongshu.com','www.xiaohongshu.com'],extractor:'XiaoHongShu'},
  reddit:{hosts:['reddit.com','www.reddit.com','old.reddit.com'],extractor:'Reddit'},
  pinterest:{hosts:['pinterest.com','www.pinterest.com','in.pinterest.com'],extractor:'Pinterest'},
});
const URL_MESSAGE='Use um link HTTPS oficial de YouTube, TikTok, Instagram, Facebook, Xiaohongshu, Reddit ou Pinterest.';
function siteFor(url){return Object.values(SITES).find(site=>site.hosts.includes(url.hostname));}
function downloadUrl(value){
  try{return officialUrl(value);}catch{}
  const url=secureURL(value);
  if(!siteFor(url))throw new Error(URL_MESSAGE);
  return url.href;
}
function isPublication(url,site){
  if(site===SITES.xiaohongshu)return url.hostname.endsWith('xiaohongshu.com')&&/^\/(?:explore|discovery\/item)\/[a-f\d]+\/?$/i.test(url.pathname);
  if(site===SITES.reddit)return /^\/(?:(?:r|user)\/[^/]+\/)?comments\/[a-z\d]+(?:\/|$)/i.test(url.pathname);
  return /^\/pin\/\d+\/?$/.test(url.pathname);
}

// Resolve somente links curtos oficiais, sem ler o corpo nem seguir HTML/JS.
// DNS público fixado na conexão; revalidação de cada Location na mesma plataforma.
// Isto NÃO é uma verificação completa de egress/CDN do processo yt-dlp.
async function resolveDownloadUrl(value,{lookup=dns.lookup,request=https.request,signal=AbortSignal.timeout(15000)}={}){
  let url=new URL(downloadUrl(value));
  const site=siteFor(url);
  if(!site)return {url:url.href,extractor:null};
  const bounded=promise=>new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('Tempo esgotado ao resolver o link. Tente o endereço completo da publicação.'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
  for(let hop=0;hop<=4;hop++){
    if(signal.aborted)throw new Error('Operação cancelada.');
    if(isPublication(url,site)){
      if(site===SITES.xiaohongshu)url.hostname='www.xiaohongshu.com';
      if(site===SITES.pinterest)url.hostname='www.pinterest.com';
      return {url:url.href,extractor:site.extractor};
    }
    if(url.hostname!=='xhslink.cn'||url.pathname==='/')throw new Error('Cole o link de uma publicação com vídeo, não de uma página inicial ou perfil.');
    const records=await bounded(lookup(url.hostname,{all:true,verbatim:true}));
    if(!records.length||records.some(record=>!isPublicIP(record.address)))throw new Error('O link resolveu para um endereço de rede não permitido.');
    const address=records[0].address;
    const location=await bounded(new Promise((resolve,reject)=>{
      const req=request(url,{method:'GET',agent:false,signal,rejectUnauthorized:true,servername:url.hostname,
        headers:{Accept:'text/html','Accept-Encoding':'identity'},
        lookup:(_host,options,callback)=>callback(null,options?.all?[{address,family:4}]:address,4)
      },res=>{
        const location=res.headers.location,status=res.statusCode;res.destroy();
        if(![301,302,303,307,308].includes(status)||!location)return reject(new Error('Não foi possível expandir o link curto. Copie o link completo da publicação no Xiaohongshu.'));
        resolve(location);
      });
      req.on('error',()=>reject(new Error('Não foi possível acessar o link curto. Tente o endereço completo da publicação.')));req.end();
    }));
    url=secureURL(new URL(location,url).href);
    if(!site.hosts.includes(url.hostname))throw new Error('Redirecionamento para fora da plataforma bloqueado.');
  }
  throw new Error('Limite de redirecionamentos excedido.');
}
module.exports={downloadUrl,resolveDownloadUrl,SITES,URL_MESSAGE};
