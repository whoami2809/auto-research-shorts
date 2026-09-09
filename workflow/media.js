'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {inflateSync}=require('node:zlib');
const {createHash}=require('node:crypto');
const {fail,WorkflowError,officialUrl,uuid}=require('./contracts');
const {MAX_BYTES,boundedBody}=require('./network');
const DOWNLOAD_BLOCK='Downloader bloqueado: faltam isolamento externo de egress para extração, autorização vinculada à publicação/CDN e validação obrigatória de quarentena. yt-dlp não será executado. Plataformas permitidas: YouTube, TikTok, Instagram e Facebook; original desconhecido.';

function safeName(name) {
  if(typeof name!=='string'||name.length>160||!name||/[<>:"/\\|?*\x00-\x1f]/.test(name)||name==='.'||name==='..'||/[. ]$/.test(name)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) fail('ARTIFACT_INVALID','Nome de arquivo inválido.');
  return name;
}
function safeArtifact(a,ctx) {
  if(!a || !uuid(ctx.jobId)||!uuid(ctx.ownerId)||!uuid(a.id)||a.isSymlink||a.symlink||a.link||a.type==='symlink') fail('ARTIFACT_INVALID','Artefato inválido ou link bloqueado.');
  safeName(a.name);
  if(!/^[a-z]+$/.test(a.stage)||!Number.isSafeInteger(a.revision)||a.revision<0) fail('ARTIFACT_INVALID','Artefato inválido.');
  const extensions={'video/mp4':'mp4','audio/mpeg':'mp3','audio/wav':'wav','image/png':'png'};
  const ext=extensions[a.mime];
  if(!ext||a.path!==`${ctx.ownerId}/${ctx.jobId}/${a.stage}/${a.revision}/${a.id}.${ext}`) fail('ARTIFACT_INVALID','Caminho do artefato fora do contrato de armazenamento.');
  if(!Number.isSafeInteger(a.size)||a.size<1||a.size>MAX_BYTES) fail('MEDIA_LIMIT','Tamanho do artefato inválido.');
  return a;
}
function mp4(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length<24||bytes.length>MAX_BYTES) fail('MEDIA_INVALID','MP4 inválido.');
  let offset=0,ftyp=false,moov=false,mdat=false,count=0;
  while(offset<bytes.length) {
    if(++count>100000||offset+8>bytes.length) fail('MEDIA_INVALID','Estrutura MP4 inválida.');
    let size=bytes.readUInt32BE(offset),header=8;
    const type=bytes.toString('ascii',offset+4,offset+8);
    if(size===1) {if(offset+16>bytes.length) fail('MEDIA_INVALID','MP4 truncado.');const big=bytes.readBigUInt64BE(offset+8);if(big>BigInt(MAX_BYTES)) fail('MEDIA_LIMIT','MP4 excede limite.');size=Number(big);header=16;}
    if(size===0) size=bytes.length-offset;
    if(size<header||offset+size>bytes.length) fail('MEDIA_INVALID','MP4 truncado.');
    if(type==='ftyp') {
      if(offset!==0||size<header+8) fail('MEDIA_INVALID','Cabeçalho MP4 inválido.');
      const brands=bytes.toString('ascii',offset+header,offset+size);
      ftyp=/isom|iso[2-9]|mp4[12]|avc1|M4V /.test(brands);
    }
    moov ||= type==='moov';mdat ||= type==='mdat';offset+=size;
  }
  if(!ftyp||!moov||!mdat) fail('MEDIA_INVALID','Arquivo não é um MP4 completo.');
}
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes) {let c=0xffffffff;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function png(bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.length>8*1024*1024) fail('MEDIA_INVALID','PNG inválido.');
  let pos=8,width=0,height=0,end=false;const data=[];
  while(pos<bytes.length) {
    if(pos+12>bytes.length) fail('MEDIA_INVALID','PNG truncado.');
    const n=bytes.readUInt32BE(pos),type=bytes.toString('ascii',pos+4,pos+8);
    if(n>bytes.length-pos-12||crc32(bytes.subarray(pos+4,pos+8+n))!==bytes.readUInt32BE(pos+8+n)) fail('MEDIA_INVALID','CRC PNG inválido.');
    if(pos===8 && type!=='IHDR') fail('MEDIA_INVALID','PNG sem IHDR.');
    if(type==='IHDR') {
      if(pos!==8||n!==13) fail('MEDIA_INVALID','IHDR inválido.');
      width=bytes.readUInt32BE(pos+8);height=bytes.readUInt32BE(pos+12);
      if(!width||!height||width>640||height>640||bytes[pos+16]!==8||bytes[pos+17]!==2||bytes[pos+18]||bytes[pos+19]||bytes[pos+20]) fail('MEDIA_INVALID','PNG fora do formato RGB esperado.');
    } else if(type==='IDAT') data.push(bytes.subarray(pos+8,pos+8+n));
    else if(type==='IEND') {if(n!==0||pos+12!==bytes.length) fail('MEDIA_INVALID','IEND inválido.');end=true;}
    pos+=n+12;
  }
  if(!end||!data.length) fail('MEDIA_INVALID','PNG incompleto.');
  let raw;try {raw=inflateSync(Buffer.concat(data),{maxOutputLength:(width*3+1)*height});}catch {fail('MEDIA_INVALID','Pixels PNG inválidos.');}
  if(raw.length!==(width*3+1)*height) fail('MEDIA_INVALID','Pixels PNG truncados.');
  for(let y=0;y<height;y++) if(raw[y*(width*3+1)]>4) fail('MEDIA_INVALID','Filtro PNG inválido.');
  return {width,height};
}
function zipStore(files,scriptName) {
  safeName(scriptName);
  if(!scriptName.endsWith('.txt')||scriptName.toLowerCase()==='creditos.txt')fail('ARTIFACT_INVALID','Nome do roteiro inválido.');
  const locals=[],central=[],seen=new Set();let offset=0;
  for(const file of files) {
    if(file.name!==scriptName&&!/^(voz\/narracao\.(mp3|wav)|creditos\.txt|videos\/[^/]+\.mp4)$/.test(file.name)) fail('ARTIFACT_INVALID','Membro ZIP fora da lista de entrega.');
    file.name.split('/').forEach(safeName);
    if(seen.has(file.name)||!Buffer.isBuffer(file.bytes)) fail('ARTIFACT_INVALID','Membro ZIP duplicado ou inválido.');
    seen.add(file.name);
    const name=Buffer.from(file.name),crc=crc32(file.bytes),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(file.bytes.length,18);header.writeUInt32LE(file.bytes.length,22);header.writeUInt16LE(name.length,26);
    const entry=Buffer.alloc(46);entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(33,14);
    entry.writeUInt32LE(crc,16);entry.writeUInt32LE(file.bytes.length,20);entry.writeUInt32LE(file.bytes.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
    locals.push(header,name,file.bytes);central.push(entry,name);offset+=header.length+name.length+file.bytes.length;
    if(offset>MAX_BYTES) fail('MEDIA_LIMIT','ZIP excede 250 MiB.');
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  if(offset+directory.length+22>MAX_BYTES) fail('MEDIA_LIMIT','ZIP excede 250 MiB.');
  return Buffer.concat([...locals,directory,end]);
}
function textBytes(text) {
  if(typeof text!=='string'||text.length>30000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)||/-----BEGIN .*PRIVATE KEY|(?:api[_-]?key|secret|password|authorization|cookie)\s*[:=]|\b(?:sk|sk_live|ghp)[_-][a-z0-9]{16,}/i.test(text)) fail('ARTIFACT_INVALID','Texto de entrega inválido ou contém marcador de credencial.');
  return Buffer.from(text,'utf8');
}
function required(message,data) {const error=new WorkflowError('INPUT_REQUIRED',message,409);error.data=data;error.files=[];throw error;}
function sampling(duration) {
  if(!Number.isFinite(duration)||duration<=0||duration>120)fail('MEDIA_LIMIT','Duração inválida.');
  // Rational rate shared by FFmpeg and output timestamps. Longer clips span
  // their entire duration instead of truncating the review to 90 seconds.
  const numerator=1000000,denominator=Math.max(1500000,Math.ceil(duration*1000000/60));
  return {numerator,denominator,interval:denominator/numerator,max_frames:60};
}
function deliveryTitle(value) {
  let title=String(value||'Roteiro').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,' ').trim().slice(0,120).replace(/[. ]+$/g,'')||'Roteiro';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(title)||title.toLowerCase()==='creditos')title=`Roteiro — ${title}`;
  safeName(`${title}.txt`);return title;
}
function boundedOperation(operation,signal) {
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(new WorkflowError('ABORTED','Operação cancelada.'));
    if(signal?.aborted) {stop();return;}
    signal?.addEventListener('abort',stop,{once:true});
    Promise.resolve().then(operation).then(resolve,reject).finally(()=>signal?.removeEventListener('abort',stop));
  });
}

function createMediaProviders({store,env=process.env}) {
  function binary(name) {
    const value=env[`WF_${name.toUpperCase()}_PATH`];
    if(typeof value!=='string'||!path.isAbsolute(value)) fail('CONFIG_MISSING',`Configure WF_${name.toUpperCase()}_PATH com o executável absoluto confiável.`,503);
    return value;
  }
  async function run(name,args,task) {
    const executable=binary(name);
    if(task.signal.aborted) fail('ABORTED','Operação cancelada.');
    const childEnv={LANG:'C',LC_ALL:'C',TMPDIR:task.dir,TMP:task.dir,TEMP:task.dir};
    if(process.platform==='win32'&&env.SystemRoot) childEnv.SystemRoot=env.SystemRoot;
    return new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{cwd:task.dir,env:childEnv,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],signal:task.signal});
      const chunks=[];let size=0,overflow=false,processError=null;
      child.stdout.on('data',b=>{size+=b.length;if(size>1024*1024){overflow=true;child.kill();}else chunks.push(b);});
      child.stderr.resume();
      child.on('error',e=>{processError=new WorkflowError(e.code==='ENOENT'?'CONFIG_MISSING':task.signal.aborted?'ABORTED':'MEDIA_INVALID','Processador de mídia indisponível ou interrompido.',503);});
      // Wait for close (not merely abort/error) before deleting the task dir.
      child.on('close',code=>processError?reject(processError):code===0&&!overflow?resolve(Buffer.concat(chunks)):reject(new WorkflowError(task.signal.aborted?'ABORTED':'MEDIA_INVALID','Processamento de mídia falhou.')));
    });
  }
  async function isolated(ctx,fn) {
    const controller=new AbortController(),cancel=()=>controller.abort();
    const timer=setTimeout(cancel,120000);ctx.signal?.addEventListener('abort',cancel,{once:true});if(ctx.signal?.aborted)cancel();
    let dir;
    try {dir=await fs.mkdtemp(path.join(os.tmpdir(),'wf-media-'));return await fn({dir,signal:controller.signal});}
    finally {clearTimeout(timer);ctx.signal?.removeEventListener('abort',cancel);if(dir)await fs.rm(dir,{recursive:true,force:true});}
  }
  async function document(ctx,task) {return (await boundedOperation(()=>store.get(ctx.jobId,ctx.ownerId),task?.signal||ctx.signal||AbortSignal.timeout(120000))).document;}
  async function readArtifact(a,ctx,task) {
    safeArtifact(a,ctx);
    const response=await boundedOperation(()=>store.download(a),task.signal);
    const bytes=await boundedBody(response,{signal:task.signal});
    if(bytes.length!==a.size) fail('MEDIA_INVALID','Tamanho armazenado divergente.');
    return bytes;
  }
  async function internalRead(task,name) {
    safeName(name);const file=path.join(task.dir,name),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>MAX_BYTES) fail('ARTIFACT_INVALID','Saída local inválida ou link bloqueado.');
    return fs.readFile(file);
  }
  async function probe(bytes,task,name,video=true) {
    if(video)mp4(bytes);
    const file=path.join(task.dir,name);await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
    const args=['-v','error','-protocol_whitelist','file','-threads','1'];
    if(video)args.push('-f','mov','-enable_drefs','0','-use_absolute_path','0');
    else args.push('-f',name.endsWith('.wav')?'wav':'mp3');
    args.push('-i',file,'-show_entries','format=duration:stream=codec_type,width,height','-of','json');
    let info;try {info=JSON.parse((await run('ffprobe',args,task)).toString());}catch(e){if(e.code)throw e;fail('MEDIA_INVALID','Metadados de mídia inválidos.');}
    const duration=Number(info.format?.duration),stream=info.streams?.find(s=>s.codec_type===(video?'video':'audio'));
    if(!stream||!Number.isFinite(duration)||duration<=0||duration>120||(video&&(!Number.isInteger(stream.width)||!Number.isInteger(stream.height)||stream.width<1||stream.height<1||stream.width>8192||stream.height>8192||stream.width*stream.height>34000000))) fail('MEDIA_LIMIT','Mídia deve ter até 120 segundos e dimensões suportadas.');
    return {file,duration,...(video?{width:stream.width,height:stream.height}:{})};
  }
  function base(doc,ctx) {
    const ref=ctx.input.base_artifact||doc.input.base_artifact;
    const id=typeof ref==='string'?ref:ref?.id;
    const artifact=doc.artifacts.find(a=>a.id===id);
    if(!artifact||artifact.mime!=='video/mp4') required('Forneça um MP4 base já armazenado neste projeto. Links não são baixados.',{required:'base_artifact'});
    return artifact;
  }
  const frames=ctx=>isolated(ctx,async task=>{
    binary('ffmpeg');binary('ffprobe');
    const doc=await document(ctx,task),a=base(doc,ctx),bytes=await readArtifact(a,ctx,task);
    const media=await probe(bytes,task,'base.mp4');const files=[],records=[],seen=new Set(),rate=sampling(media.duration);
    await run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-xerror','-protocol_whitelist','file','-threads','1','-f','mov','-enable_drefs','0','-use_absolute_path','0','-i',media.file,'-map','0:v:0','-an','-sn','-dn','-frames:v','60','-vf',`setpts=PTS-STARTPTS,fps=fps=${rate.numerator}/${rate.denominator}:start_time=0:round=up:eof_action=pass,scale=640:640:force_original_aspect_ratio=decrease`,'-fps_mode','passthrough','-pix_fmt','rgb24','-threads','1','-start_number','1','-f','image2',path.join(task.dir,'frame_%04d.png')],task);
    const names=(await fs.readdir(task.dir)).filter(n=>/^frame_\d{4}\.png$/.test(n)).sort();
    if(!names.length||names.length>60)fail('MEDIA_INVALID','Quantidade de frames inválida.');
    let total=0;
    for(let i=0;i<names.length;i++) {
      const name=`frame_${String(i+1).padStart(4,'0')}.png`,timestamp=i*rate.denominator/rate.numerator;
      if(names[i]!==name)fail('MEDIA_INVALID','Sequência PNG incompleta.');
      const frame=await internalRead(task,name),dimensions=png(frame),hash=createHash('sha256').update(frame).digest('hex');
      total+=frame.length;if(total>MAX_BYTES)fail('MEDIA_LIMIT','Frames excedem 250 MiB.');
      records.push({name,timestamp,pts:i,time_base:{numerator:rate.denominator,denominator:rate.numerator},...dimensions,sha256:hash,duplicate_bytes:seen.has(hash)});seen.add(hash);
      files.push({name,mime:'image/png',bytes:frame});
    }
    return {data:{base_artifact:a.id,frames:records,sampling:rate,timestamp_basis:'normalized_output_pts',blur_checked:false,visual_match_verified:false,scene_count_verified:false,source_uniqueness_verified:false},files};
  });
  async function busca(ctx) {
    if(!Array.isArray(ctx.input.links||[])||(ctx.input.links||[]).length>25)fail('INPUT_INVALID','Forneça até 25 candidatos manuais.');
    const doc=await document(ctx),stage=doc.stages.find(s=>s.name==='frames'&&s.status==='ready');
    const ids=stage?.output?.artifact_ids||[];
    const queue=doc.artifacts.filter(a=>ids.includes(a.id)&&a.stage==='frames'&&a.mime==='image/png').map(a=>({artifact_id:a.id,name:safeName(a.name),action:'Revisar frame e pesquisar manualmente no Google Lens',lens_url:'https://lens.google.com/',uploaded:false,match_verified:false}));
    const candidates=(ctx.input.links||[]).map(value=>({url:officialUrl(value),publisher:null,original:'desconhecido',match_verified:false,license_status:'não verificado',safety:{ok:false},download_authorized:false}));
    required('Pesquisa manual necessária: conferir correspondência visual, autoria e licença nas plataformas oficiais. Nenhum frame foi enviado ao Lens.',{status:'input_required',queue,candidates,automatic_search:false,frame_upload_performed:false,allowed_platforms:['YouTube','TikTok','Instagram','Facebook'],max_references:25});
  }
  async function downloads() {fail('CONFIG_MISSING',DOWNLOAD_BLOCK,503);}
  const organizar=ctx=>isolated(ctx,async task=>{
    const doc=await document(ctx,task),a=base(doc,ctx),script=ctx.input.script;
    if(!script)required('Forneça o roteiro antes de empacotar.',{required:'script'});
    const voiceStage=doc.stages.find(s=>s.name==='voz'&&s.status==='ready');
    const voices=doc.artifacts.filter(a=>voiceStage?.output?.artifact_ids?.includes(a.id)&&a.stage==='voz'&&['audio/mpeg','audio/wav'].includes(a.mime));
    if(voices.length!==1)required('É necessária uma narração atual armazenada.',{required:'voz'});
    binary('ffprobe');
    const title=deliveryTitle(ctx.input.title),scriptName=`${title}.txt`;
    const files=[{name:scriptName,bytes:textBytes(script)}];
    const voice=voices[0],voiceBytes=await readArtifact(voice,ctx,task),ext=voice.mime==='audio/wav'?'wav':'mp3';
    await probe(voiceBytes,task,`narracao.${ext}`,false);files.push({name:`voz/narracao.${ext}`,bytes:voiceBytes});
    const selected=[a];
    const downloadStage=doc.stages.find(s=>s.name==='downloads'&&s.status==='ready');
    for(const artifact of doc.artifacts) if(downloadStage?.output?.artifact_ids?.includes(artifact.id)&&artifact.stage==='downloads'&&artifact.mime==='video/mp4'&&artifact.id!==a.id)selected.push(artifact);
    if(selected.length>26)fail('MEDIA_LIMIT','Entrega limitada ao vídeo base e até 25 referências.');
    let total=files.reduce((n,f)=>n+f.bytes.length,0);
    for(let i=0;i<selected.length;i++) {
      if(total+selected[i].size>MAX_BYTES-65536)fail('MEDIA_LIMIT','Entrega excede 250 MiB.');
      const bytes=await readArtifact(selected[i],ctx,task);await probe(bytes,task,`video_${i}.mp4`);
      files.push({name:i===0?'videos/base.mp4':`videos/video_${i}.mp4`,bytes});total+=bytes.length;
    }
    const credits=['Créditos e pendências','Original: desconhecido.','Autoria, licença e correspondência visual: não verificadas.',...selected.map((a,i)=>`${i===0?'Base':`Vídeo ${i}`}: artefato ${a.id}; autor/licença não verificados.`)].join('\n');
    files.push({name:'creditos.txt',bytes:textBytes(credits)});
    return {data:{delivery_name:title,partial:true,video_count:selected.length,entries:files.map(f=>f.name),pending:['Verificar autoria, licenças e correspondência das referências selecionadas.'],network_safety_verified:false,antimalware_verified:false},files:[{name:`${title}.zip`,mime:'application/zip',bytes:zipStore(files,scriptName)}]};
  });
  // Router supplies name/mime and owns authorization. No user filesystem paths
  // or storage calls. On success file.bytes is replaced by a canonical, non-lossy
  // copy; the router MUST persist that same buffer, not the original upload.
  // This strips metadata/chapters only and keeps codec quality intact.
  const validateImport=(ctx,file)=>isolated(ctx,async task=>{
    if(!file||!Buffer.isBuffer(file.bytes)||!file.bytes.length||file.bytes.length>MAX_BYTES)fail('MEDIA_INVALID','Importação deve conter Buffer de até 250 MiB.');
    safeName(file.name);
    const ext={'video/mp4':'mp4','audio/mpeg':'mp3','audio/wav':'wav'}[file.mime];
    if(!ext)fail('MEDIA_INVALID','Importação aceita somente MP4, MP3 ou WAV.');
    binary('ffprobe');binary('ffmpeg');
    const video=file.mime==='video/mp4',original=await probe(file.bytes,task,`import.${ext}`,video);
    const args=['-hide_banner','-loglevel','error','-nostdin','-n','-xerror','-protocol_whitelist','file','-threads','1'];
    if(video)args.push('-f','mov','-enable_drefs','0','-use_absolute_path','0');else args.push('-f',ext);
    args.push('-i',original.file);
    if(video) {
      args.push('-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart');
    } else {
      args.push('-map','0:a:0','-vn','-c:a','copy');
    }
    args.push('-sn','-dn','-map_metadata','-1','-map_chapters','-1','-threads','1','-t','121','-fs',String(MAX_BYTES+1));
    args.push('-f',ext,path.join(task.dir,`canonical.${ext}`));
    await run('ffmpeg',args,task);
    const canonical=await internalRead(task,`canonical.${ext}`),validated=await probe(canonical,task,`validated.${ext}`,video);
    if(Math.abs(validated.duration-original.duration)>0.25)fail('MEDIA_INVALID','Duração recodificada divergente; importação não será armazenada.');
    if(task.signal.aborted)fail('ABORTED','Operação cancelada.');
    file.bytes=canonical;
    return {duration:validated.duration,...(video?{width:validated.width,height:validated.height}:{})};
  });
  return {frames,busca,downloads,organizar,validateImport};
}
module.exports={createMediaProviders,DOWNLOAD_BLOCK,_test:{safeName,safeArtifact,mp4,png,crc32,zipStore,textBytes,sampling,deliveryTitle}};
