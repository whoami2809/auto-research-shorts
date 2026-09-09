'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises');
const path=require('node:path');
const childProcess=require('node:child_process');
const {deflateSync}=require('node:zlib');
const {createMediaProviders,_test,DOWNLOAD_BLOCK}=require('../media');
const {stageInput}=require('../contracts');
const {isPublicIP,secureURL,boundedBody,createPinnedTransport}=require('../network');
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',job='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const baseId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',voiceId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ctx={jobId:job,ownerId:owner,input:{base_artifact:baseId,script:'Um roteiro seguro.',title:'Entrega'},outputs:{}};
function box(type,body=Buffer.alloc(0)) {const h=Buffer.alloc(8);h.writeUInt32BE(body.length+8);h.write(type,4);return Buffer.concat([h,body]);}
const video=Buffer.concat([box('ftyp',Buffer.from('isom\0\0\0\0isom')),box('moov'),box('mdat')]);
function fixturePNG() {
  const chunk=(type,bytes)=>{const data=Buffer.concat([Buffer.from(type),bytes]),h=Buffer.alloc(4),crc=Buffer.alloc(4);h.writeUInt32BE(bytes.length);crc.writeUInt32BE(_test.crc32(data));return Buffer.concat([h,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
}
function artifact(id,stage,mime,bytes) {
  const ext=mime==='video/mp4'?'mp4':'wav';
  return {id,stage,mime,revision:1,size:bytes.length,name:`media.${ext}`,path:`${owner}/${job}/${stage}/1/${id}.${ext}`};
}
function storage() {
  const audio=Buffer.from('RIFFfixtureWAVE');
  const document={input:{base_artifact:baseId},stages:[{name:'voz',status:'ready',output:{artifact_ids:[voiceId]}}],artifacts:[artifact(baseId,'entrada','video/mp4',video),artifact(voiceId,'voz','audio/wav',audio)]};
  let reads=0;
  return {document,get reads(){return reads;},get:async(j,o)=>{assert.equal(j,job);assert.equal(o,owner);return {document};},download:async a=>{reads++;return new Response(a.id===baseId?video:audio);},put:()=>assert.fail('Main exclusively persists files')};
}
const config={WF_FFMPEG_PATH:process.execPath,WF_FFPROBE_PATH:process.execPath,SECRET:'must-not-propagate',PATH:'must-not-propagate'};
function zipEntries(bytes) {
  const entries=[];let p=0;
  while(bytes.readUInt32LE(p)===0x04034b50) {
    const size=bytes.readUInt32LE(p+18),n=bytes.readUInt16LE(p+26),extra=bytes.readUInt16LE(p+28),name=bytes.toString('utf8',p+30,p+30+n),start=p+30+n+extra;
    const data=bytes.subarray(start,start+size);assert.equal(_test.crc32(data),bytes.readUInt32LE(p+14));entries.push({name,data});p=start+size;
  }
  assert.equal(bytes.readUInt32LE(p),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  return entries;
}

test('names and store references reject traversal, external paths and links',()=>{
  for(const name of ['../x','..','/tmp/x','C:\\x','.env/secret','a\0b','CON.txt']) assert.throws(()=>_test.safeName(name),{code:'ARTIFACT_INVALID'});
  const a=artifact(baseId,'entrada','video/mp4',video);
  assert.equal(_test.safeArtifact(a,ctx),a);
  for(const patch of [{path:'../../.env'},{path:`${owner}/${job}/entrada/1/../${baseId}.mp4`},{symlink:true},{isSymlink:true},{link:'/etc/passwd'},{type:'symlink'},{name:'../outside.mp4'}]) assert.throws(()=>_test.safeArtifact({...a,...patch},ctx),{code:'ARTIFACT_INVALID'});
});
test('actual types: fake MP4 and damaged PNG are rejected',()=>{
  _test.mp4(video);assert.throws(()=>_test.mp4(Buffer.from('MZ executable renamed.mp4')),{code:'MEDIA_INVALID'});
  assert.deepEqual(_test.png(fixturePNG()),{width:1,height:1});
  const corrupt=fixturePNG();corrupt[20]^=1;assert.throws(()=>_test.png(corrupt),{code:'MEDIA_INVALID'});
  assert.throws(()=>_test.png(Buffer.from('JPEG named.png')),{code:'MEDIA_INVALID'});
  assert.throws(()=>_test.mp4(video.subarray(0,video.length-1)),{code:'MEDIA_INVALID'});
});
test('ZIP is deterministic, whitelist-only and preserves binary bytes',()=>{
  const scriptName='Abraço em Canção — São João.txt';
  const files=[{name:scriptName,bytes:Buffer.from('Olá')},{name:'videos/base.mp4',bytes:video}];
  const one=_test.zipStore(files,scriptName);assert.deepEqual(one,_test.zipStore(files,scriptName));
  assert.deepEqual(zipEntries(one).map(x=>x.name),files.map(x=>x.name));
  assert.deepEqual(zipEntries(one)[1].data,video);
  for(const name of ['.env','logs/debug.txt','videos/../x.mp4','videos/sub/x.mp4','entrada/base.mp4','voz/password.txt','roteiro/titulo.txt','log.txt']) assert.throws(()=>_test.zipStore([{name,bytes:Buffer.from('x')}],scriptName),{code:'ARTIFACT_INVALID'});
  assert.throws(()=>_test.zipStore([files[0],files[0]],scriptName),{code:'ARTIFACT_INVALID'});
  assert.throws(()=>_test.zipStore([{name:'creditos.txt',bytes:'not a buffer'}],scriptName),{code:'ARTIFACT_INVALID'});
  assert.throws(()=>_test.textBytes('api_key=secret'),{code:'ARTIFACT_INVALID'});
});
test('network denies non-public addresses, credentials, non-HTTPS and literal IP',()=>{
  for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.0.1','192.0.0.8','198.18.0.1','203.0.113.1','::1','::ffff:8.8.8.8','2001:4860:4860::8888'])assert.equal(isPublicIP(ip),false,ip);
  assert.equal(isPublicIP('8.8.8.8'),true);
  for(const url of ['http://youtube.com/v','https://user:pass@youtube.com/v','https://127.0.0.1/v','https://youtube.com:444/v','https://youtube.com/\\x'])assert.throws(()=>secureURL(url),{code:'NETWORK_DENIED'});
});
test('host allowlist or candidate approved data cannot authorize download',async()=>{
  let calls=0;const store={get(){calls++;},download(){calls++;}};
  const providers=createMediaProviders({store,env:{}});
  await assert.rejects(providers.downloads({...ctx,input:{links:['https://www.youtube.com/watch?v=a'],approved:true,safety:{ok:true}}}),e=>e.code==='CONFIG_MISSING'&&e.message===DOWNLOAD_BLOCK);
  assert.equal(calls,0);
  await assert.rejects(createPinnedTransport({request:()=>assert.fail('No request')})('https://www.youtube.com/v'),{code:'CONFIG_MISSING'});
});
test('DNS checked before any connection, all returned addresses must be public',async()=>{
  const transfer=createPinnedTransport({verifyDestination:async({url,origin})=>({url,origin,authorized:true,publicationBound:true}),lookup:async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],request:()=>assert.fail('Private DNS must not connect')});
  await assert.rejects(transfer('https://www.youtube.com/v'),{code:'NETWORK_DENIED'});
});
test('pins selected DNS IP and independently rejects unverified CDN redirect',async()=>{
  let requests=0,verifications=0;
  const transfer=createPinnedTransport({
    verifyDestination:async({url,origin,previous})=>{verifications++;return previous?null:{url,origin,authorized:true,publicationBound:true};},
    lookup:async()=>[{address:'8.8.8.8',family:4}],
    request:(url,options,callback)=>{
      requests++;assert.equal(url.origin,'https://www.youtube.com');assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);
      options.lookup('www.youtube.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
      const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'https://cdn.example/video.mp4'};res.destroy=()=>{};callback(res);};return req;
    }
  });
  await assert.rejects(transfer('https://www.youtube.com/v'),{code:'NETWORK_DENIED'});assert.equal(requests,1);assert.equal(verifications,2);
});
test('body consumption enforces size even when content length is absent',async()=>{
  await assert.rejects(boundedBody(new Response(Buffer.alloc(20)),{maxBytes:10}),{code:'MEDIA_LIMIT'});
  assert.deepEqual(await boundedBody(new Response(Buffer.from('safe'))),Buffer.from('safe'));
  const controller=new AbortController();controller.abort();await assert.rejects(boundedBody(new Response('x'),{signal:controller.signal}),{code:'ABORTED'});
});
test('busca exposes manual queue as INPUT_REQUIRED and has no Lens/upload effects',async()=>{
  const store=storage();store.document.stages.push({name:'frames',status:'ready',output:{artifact_ids:[baseId]}});
  store.document.artifacts[0]={...store.document.artifacts[0],stage:'frames',mime:'image/png',name:'frame_0001.png'};
  const providers=createMediaProviders({store,env:{}});
  await assert.rejects(providers.busca({...ctx,allowFrameUpload:true,input:{links:['https://www.instagram.com/p/example/']}}),error=>{
    assert.equal(error.code,'INPUT_REQUIRED');assert.equal(error.data.automatic_search,false);assert.equal(error.data.frame_upload_performed,false);assert.equal(error.data.queue.length,1);assert.equal(error.data.candidates[0].download_authorized,false);assert.equal(error.data.candidates[0].publisher,null);assert.deepEqual(error.data.allowed_platforms,['YouTube','TikTok','Instagram','Facebook']);assert.equal(error.data.max_references,25);assert.equal(error.data.required_publishers,undefined);return true;
  });assert.equal(store.reads,0);
});
test('missing binary configuration fails closed before storage transfer',async()=>{
  const store=storage();await assert.rejects(createMediaProviders({store,env:{}}).frames(ctx),{code:'CONFIG_MISSING'});assert.equal(store.reads,0);
});

// Offline subprocess fixture: production still validates real PNG bytes and
// filesystem output, but no ffmpeg, network or paid API is invoked by tests.
test('providers return buffers, retain identical frames honestly and clean isolated temp',async t=>{
  const dirs=new Set(),calls=[];let spawns=0;
  t.mock.method(childProcess,'spawn',(executable,args,options)=>{
    spawns++;assert.equal(executable,process.execPath);assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.env.SECRET,undefined);assert.equal(options.env.PATH,undefined);
    assert.equal(options.env.TMPDIR,options.cwd);dirs.add(options.cwd);
    calls.push(args.includes('-show_entries')?`probe:${path.basename(args[args.indexOf('-i')+1])}`:`extract:${path.basename(args.at(-1))}`);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};child.kill=()=>{};
    setImmediate(async()=>{
      try {
        if(args.includes('-show_entries'))child.stdout.emit('data',Buffer.from(JSON.stringify({format:{duration:'6'},streams:[{codec_type:'video',width:640,height:360},{codec_type:'audio'}]})));
        else {
          assert.ok(args.includes('-enable_drefs'));assert.ok(args.includes('-use_absolute_path'));assert.ok(args.includes('-nostdin'));
          assert.equal(args[args.indexOf('-frames:v')+1],'60');assert.equal(args[args.indexOf('-fps_mode')+1],'passthrough');
          assert.match(args[args.indexOf('-vf')+1],/fps=fps=1000000\/1500000:start_time=0:round=up:eof_action=pass/);
          const output=args.at(-1);assert.equal(path.dirname(output),options.cwd);
          for(let n=1;n<=4;n++)await fs.writeFile(output.replace('%04d',String(n).padStart(4,'0')),fixturePNG());
        }
        child.emit('close',0);
      }catch(error){child.emit('error',error);child.emit('close',1);}
    });return child;
  });
  delete require.cache[require.resolve('../media')];const {createMediaProviders:factory}=require('../media');
  const store=storage(),providers=factory({store,env:config});
  const framesInput=stageInput('frames',{base_url:'https://www.youtube.com/watch?v=example'},[]);
  assert.deepEqual(framesInput,{base_url:'https://www.youtube.com/watch?v=example',base_artifact:null});
  // Null in the engine context uses the base registered in this owner's job.
  const frames=await providers.frames({...ctx,input:framesInput,outputs:{voz:{duration:6}}});assert.equal(frames.files.length,4);assert.equal(frames.data.frames[1].duplicate_bytes,true);assert.equal(frames.data.source_uniqueness_verified,false);
  assert.deepEqual(frames.data.frames.map(f=>f.timestamp),[0,1.5,3,4.5]);assert.equal(frames.data.scene_count_verified,false);
  for(const file of frames.files){assert.ok(Buffer.isBuffer(file.bytes));assert.equal(file.mime,'image/png');_test.png(file.bytes);}
  const organizeInput=stageInput('organizar',{script:ctx.input.script,title:'Abraço em Canção — São João'},store.document.stages);
  assert.deepEqual(Object.keys(organizeInput),['script','title','outputs']);assert.ok(Array.isArray(organizeInput.outputs));
  const result=await providers.organizar({...ctx,input:organizeInput,outputs:{voz:{duration:6},frames:frames.data}});assert.equal(result.data.partial,true);assert.equal(result.files[0].mime,'application/zip');assert.ok(Buffer.isBuffer(result.files[0].bytes));
  assert.deepEqual(zipEntries(result.files[0].bytes).map(x=>x.name),['Abraço em Canção — São João.txt','voz/narracao.wav','videos/base.mp4','creditos.txt']);
  assert.equal(spawns,4);
  assert.deepEqual(calls,['probe:base.mp4','extract:frame_%04d.png','probe:narracao.wav','probe:video_0.mp4']);
  assert.equal(dirs.size,2);for(const dir of dirs)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
  t.diagnostic(`Observed ${calls.join(', ')}; four PNGs at 0/1.5/3/4.5 seconds read successfully; both temporary directories removed.`);
  delete require.cache[require.resolve('../media')];
});
test('null base without stored registration requires input and never downloads the URL',async()=>{
  const store=storage();store.document.input={};
  const input=stageInput('frames',{base_url:'https://www.youtube.com/watch?v=example'},[]);
  await assert.rejects(createMediaProviders({store,env:config}).frames({...ctx,input}),{code:'INPUT_REQUIRED'});
  assert.equal(store.reads,0);
});
test('store path uses four directories plus file; display name does not select object',()=>{
  const a=artifact(baseId,'entrada','video/mp4',video);
  assert.equal(a.path.split('/').length,5);
  assert.equal(_test.safeArtifact({...a,name:'Nome editorial distinto.mp4'},ctx).path,a.path);
  for(const changed of [a.path.replace('/entrada/1/','/entrada/'),a.path.replace(`${owner}/`,`${voiceId}/`),a.path.replace(`/${job}/`,`/${voiceId}/`),a.path.replace('.mp4','.wav')]) {
    assert.throws(()=>_test.safeArtifact({...a,path:changed},ctx),{code:'ARTIFACT_INVALID'});
  }
});
test('stored links/path traversal are rejected before reading any bytes',async()=>{
  const store=storage();store.document.artifacts[0].path='../outside.mp4';
  await assert.rejects(createMediaProviders({store,env:config}).frames(ctx),{code:'ARTIFACT_INVALID'});assert.equal(store.reads,0);
});
test('missing installed executable produces CONFIG_MISSING and cleans temp',async()=>{
  const store=storage();
  const env={WF_FFMPEG_PATH:process.execPath,WF_FFPROBE_PATH:path.join(path.dirname(process.execPath),'wf-nonexistent-ffprobe-5d842be7')};
  await assert.rejects(createMediaProviders({store,env}).frames(ctx),{code:'CONFIG_MISSING'});
});
test('cancellation bounds a stalled storage request without any download',async()=>{
  const controller=new AbortController();let downloaded=false;
  const store={get:()=>new Promise(()=>{}),download:()=>{downloaded=true;}};
  const pending=createMediaProviders({store,env:config}).frames({...ctx,signal:controller.signal});
  setTimeout(()=>controller.abort(),20);
  await assert.rejects(pending,{code:'ABORTED'});assert.equal(downloaded,false);
});

function mockedMedia(t,state={}) {
  const calls=[],dirs=new Set();
  t.mock.method(childProcess,'spawn',(_exe,args,options)=>{
    calls.push(args);dirs.add(options.cwd);
    assert.equal(options.shell,false);assert.equal(options.env.SECRET,undefined);
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};child.kill=()=>{};
    setImmediate(async()=>{
      try {
        if(args.includes('-show_entries')) {
          const input=args[args.indexOf('-i')+1],duration=input.includes('validated.')?(state.validatedDuration??state.duration??6):(state.duration??6);
          child.stdout.emit('data',Buffer.from(JSON.stringify({format:{duration:String(duration)},streams:[{codec_type:'video',width:320,height:180},{codec_type:'audio'}]})));
        } else if(args.at(-1).includes('frame_%04d.png')) {
          const filter=args[args.indexOf('-vf')+1],match=filter.match(/fps=fps=(\d+)\/(\d+)/);assert.ok(match);
          const count=Math.min(60,Math.ceil((state.duration??6)*Number(match[1])/Number(match[2])));
          for(let n=1;n<=count;n++)await fs.writeFile(args.at(-1).replace('%04d',String(n).padStart(4,'0')),fixturePNG());
        } else {
          assert.equal(args[args.indexOf('-map_metadata')+1],'-1');assert.equal(args[args.indexOf('-map_chapters')+1],'-1');assert.ok(args.includes('-xerror'));
          if(state.encodeFailure){child.emit('close',1);return;}
          const target=args.at(-1);assert.equal(path.dirname(target),options.cwd);
          await fs.writeFile(target,target.endsWith('.mp4')?Buffer.concat([video,box('free',Buffer.from('canonical'))]):Buffer.from('canonical audio fixture'));
        }
        child.emit('close',0);
      }catch(e){child.emit('error',e);child.emit('close',1);}
    });return child;
  });
  delete require.cache[require.resolve('../media')];
  const factory=require('../media').createMediaProviders;
  t.after(()=>{delete require.cache[require.resolve('../media')];});
  return {factory,calls,dirs};
}
test('dynamic frames cover short and long clips with a single FFmpeg pass and exact rational PTS',async t=>{
  const state={},mock=mockedMedia(t,state),providers=mock.factory({store:storage(),env:config});
  for(const duration of [0.1,9.1,90,100.001,120]) {
    state.duration=duration;const before=mock.calls.length,result=await providers.frames(ctx),rate=_test.sampling(duration);
    assert.equal(mock.calls.length-before,2,'one probe plus one extraction');
    assert.equal(result.files.length,Math.min(60,Math.ceil(duration/rate.interval)));
    assert.ok(result.files.length>=1&&result.files.length<=60);
    result.data.frames.forEach((f,i)=>{assert.equal(f.timestamp,i*rate.denominator/rate.numerator);assert.equal(f.pts,i);assert.equal(f.time_base.numerator,rate.denominator);});
    assert.equal(result.data.timestamp_basis,'normalized_output_pts');assert.equal(result.data.scene_count_verified,false);
  }
  for(const dir of mock.dirs)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
});
test('ZIP allows base plus 25 references and rejects 26 references',async t=>{
  const mock=mockedMedia(t),store=storage();
  store.download=async a=>new Response(a.mime==='video/mp4'?video:Buffer.from('RIFFfixtureWAVE'));
  const stage={name:'downloads',status:'ready',output:{artifact_ids:[]}};store.document.stages.push(stage);
  function add(n) {const id=`${String(n).padStart(8,'0')}-eeee-4eee-8eee-eeeeeeeeeeee`;store.document.artifacts.push(artifact(id,'downloads','video/mp4',video));stage.output.artifact_ids.push(id);}
  for(let n=1;n<=25;n++)add(n);
  const providers=mock.factory({store,env:config}),result=await providers.organizar(ctx);
  assert.equal(result.data.video_count,26);assert.equal(zipEntries(result.files[0].bytes).filter(f=>f.name.startsWith('videos/')).length,26);
  add(26);await assert.rejects(providers.organizar(ctx),{code:'MEDIA_LIMIT'});
});
test('validateImport preserves codec quality on canonical copy and probes canonical duration',async t=>{
  const mock=mockedMedia(t),store={get:()=>assert.fail('No storage'),download:()=>assert.fail('No storage'),put:()=>assert.fail('No storage')};
  const providers=mock.factory({store,env:config});
  for(const [mime,name,bytes] of [['video/mp4','Vídeo escolhido.mp4',video],['audio/wav','Narração.wav',Buffer.from('RIFFfixtureWAVE')],['audio/mpeg','Narração.mp3',Buffer.from('ID3fixture')]]) {
    const file={mime,name,bytes},before=mock.calls.length,result=await providers.validateImport({signal:ctx.signal},file);
    assert.deepEqual(result,mime==='video/mp4'?{duration:6,width:320,height:180}:{duration:6});
    assert.notDeepEqual(file.bytes,bytes);assert.ok(Buffer.isBuffer(file.bytes));assert.equal(file.name,name);assert.equal(file.mime,mime);
    assert.equal(mock.calls.length-before,3,'original probe, remux copy, canonical probe');
    const args=mock.calls[before+1];assert.ok(args.includes('-map_metadata'));assert.ok(args.includes('-map_chapters'));
    assert.ok(args.includes('-c') ? args[args.indexOf('-c')+1]==='copy' : args[args.indexOf('-c:a')+1]==='copy');
    assert.equal(result.scanned,undefined);
  }
  for(const dir of mock.dirs)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
});
test('validateImport rejects traversal, unknown format, fake MP4 and non-buffer before subprocesses',async t=>{
  const mock=mockedMedia(t),providers=mock.factory({store:{},env:config});
  for(const file of [{name:'../user.mp4',mime:'video/mp4',bytes:video},{name:'x.mp4',mime:'video/mp4',bytes:'string'},{name:'x.mp4',mime:'video/mp4',bytes:Buffer.from('MZ-executable')},{name:'x.exe',mime:'application/octet-stream',bytes:video}])await assert.rejects(providers.validateImport({},file));
  assert.equal(mock.calls.length,0);
});
test('validateImport leaves original buffer intact on duration, decode and canonical verification failures',async t=>{
  const state={duration:121},mock=mockedMedia(t,state),providers=mock.factory({store:{},env:config});
  const file={name:'base.mp4',mime:'video/mp4',bytes:video};
  await assert.rejects(providers.validateImport({},file),{code:'MEDIA_LIMIT'});assert.equal(file.bytes,video);
  state.duration=6;state.encodeFailure=true;await assert.rejects(providers.validateImport({},file),{code:'MEDIA_INVALID'});assert.equal(file.bytes,video);
  state.encodeFailure=false;state.validatedDuration=3;await assert.rejects(providers.validateImport({},file),{code:'MEDIA_INVALID'});assert.equal(file.bytes,video);
  for(const dir of mock.dirs)await assert.rejects(fs.stat(dir),{code:'ENOENT'});
});
test('validateImport fails closed when transcoder configuration is missing',async()=>{
  await assert.rejects(createMediaProviders({store:{},env:{}}).validateImport({},{name:'base.mp4',mime:'video/mp4',bytes:video}),{code:'CONFIG_MISSING'});
});
test('Python zipfile round trip verifies Unicode root title, CRC and exact payloads',t=>{
  const python=process.env.WF_TEST_PYTHON;
  if(!python||!path.isAbsolute(python)){t.skip('Set WF_TEST_PYTHON to an installed absolute Python executable for independent ZIP validation.');return;}
  const scriptName='Abraço em Canção — São João.txt';
  const files=[{name:scriptName,bytes:Buffer.from('Olá, mundo!')},{name:'creditos.txt',bytes:Buffer.from('Créditos')},{name:'voz/narracao.wav',bytes:Buffer.from('WAVE fixture')},{name:'videos/base.mp4',bytes:video}];
  const code='import sys,io,zipfile,json,base64; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({"bad":z.testzip(),"entries":[{"name":i.filename,"utf8":bool(i.flag_bits & 2048),"bytes":base64.b64encode(z.read(i)).decode("ascii")} for i in z.infolist()]}))';
  const result=childProcess.spawnSync(python,['-I','-c',code],{input:_test.zipStore(files,scriptName),windowsHide:true,shell:false,timeout:15000,maxBuffer:1048576});
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr?.toString());
  const data=JSON.parse(result.stdout);assert.equal(data.bad,null);
  assert.deepEqual(data.entries,files.map(f=>({name:f.name,utf8:true,bytes:f.bytes.toString('base64')})));
});
