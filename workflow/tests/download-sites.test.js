const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {downloadUrl,resolveDownloadUrl,SITES}=require('../download-sites');
const {officialUrl}=require('../contracts');
const app=fs.readFileSync(require('node:path').join(__dirname,'../../public/index.html'),'utf8');
const parser=app.slice(app.indexOf('  function isSupportedLink('),app.indexOf('  function linksInTextarea('));
const context=vm.createContext({URL});vm.runInContext(parser,context);
const examples=['https://xhslink.cn/o/A3mxk6123s3','https://in.pinterest.com/pin/708261478933750684/','https://www.reddit.com/r/SweatyPalms/comments/x8cr6s/paraglider/'];
test('single and batch accept exactly the new hosts and preserve original platforms',()=>{
  for(const site of Object.values(SITES))for(const host of site.hosts){assert.equal(new URL(downloadUrl('https://'+host+'/')).hostname,host);assert.equal(context.isSupportedLink('https://'+host+'/'),true);}
  for(const url of ['https://m.youtube.com/watch?v=x','https://www.tiktok.com/@x/video/1','https://instagram.com/reel/x','https://fb.watch/x',...examples]){assert.ok(downloadUrl(url));assert.equal(context.isSupportedLink(url),true);}
  assert.deepEqual(Array.from(context.linksFromClipboard(examples.join('')+examples[0])),examples);
});
test('new sites do not authorize workflow and reject malicious URLs in both validators',()=>{
  for(const url of examples)assert.throws(()=>officialUrl(url));
  for(const url of ['http://xhslink.cn/o/x','https://pinterest.com.evil.test/pin/1','https://127.0.0.1/','https://user:pass@reddit.com/x','https://xhslink.cn:444/x','https://foo.reddit.com/x','https://x.com/x','file:///x']){
    assert.throws(()=>downloadUrl(url));assert.equal(context.isSupportedLink(url),false);
  }
});
test('batch cleans Chinese share text, Markdown, repeated and adjacent URLs without stripping tokens',()=>{
  const url='https://xhslink.cn/o/9bGvyBkXDP0';
  for(const text of ['你的串包浆怎么样 '+url+' Copy and open rednote to view the note','你的串包浆怎么样 ['+url+']('+url+') Copy and open rednote to view the note','【'+url+'】']){
    assert.deepEqual(Array.from(context.linksFromClipboard(text)),[url]);
  }
  const signed='https://www.xiaohongshu.com/explore/abcdef?xsec_token=abc%2Bdef%3D&xsec_source=pc_share';
  assert.deepEqual(Array.from(context.linksFromClipboard('['+signed+']('+signed+')。'+url)),[signed,url]);
  assert.match(app,/var links = linksFromClipboard\(raw\)/);
});
test('normal paste formats links but never starts a download',()=>{
  const listeners={};const textarea={value:'',selectionStart:0,selectionEnd:0,addEventListener:(name,handler)=>listeners[name]=handler};
  const scope=vm.createContext({URL,textarea,pasteStatus:{}});vm.runInContext(parser,scope);
  const start=app.indexOf("  textarea.addEventListener('paste'");
  vm.runInContext(app.slice(start,app.indexOf("  pasteBtn.addEventListener('click'",start)),scope);
  let prevented=false;listeners.paste({clipboardData:{getData:()=> '你的串包浆怎么样 https://xhslink.cn/o/9bGvyBkXDP0 Copy and open rednote to view the note'},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(textarea.value,'https://xhslink.cn/o/9bGvyBkXDP0');
});
function mocked(locations,addresses=['8.8.8.8']){
  let calls=0;
  return {lookup:async()=>addresses.map(address=>({address,family:4})),request(url,options,callback){
    assert.equal(url.hostname,'xhslink.cn');assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);
    options.lookup(url.hostname,{all:true},(error,result)=>assert.equal(result[0].address,addresses[0]));
    const req=new EventEmitter();req.end=()=>queueMicrotask(()=>callback({statusCode:302,headers:{location:locations[calls++]},destroy(){}}));return req;
  },calls:()=>calls};
}
test('short URL resolves within Xiaohongshu and preserves required sharing parameters',async()=>{
  const stub=mocked(['https://www.xiaohongshu.com/discovery/item/abcdef?xsec_token=example']);
  const result=await resolveDownloadUrl(examples[0],stub);
  assert.equal(result.extractor,'XiaoHongShu');assert.equal(new URL(result.url).searchParams.get('xsec_token'),'example');assert.equal(stub.calls(),1);
});
test('short URL blocks external redirects, HTTP, private DNS and loops before downloader',async()=>{
  for(const location of ['https://evil.test/x','http://www.xiaohongshu.com/explore/abcdef','https://127.0.0.1/','https://user:pass@www.xiaohongshu.com/explore/abcdef'])await assert.rejects(resolveDownloadUrl(examples[0],mocked([location])));
  const privateDNS=mocked([],['127.0.0.1']);await assert.rejects(resolveDownloadUrl(examples[0],privateDNS));assert.equal(privateDNS.calls(),0);
  const loop=mocked(Array(5).fill(examples[0]));await assert.rejects(resolveDownloadUrl(examples[0],loop),/Limite/);assert.equal(loop.calls(),5);
});
test('new home/profile URLs fail and canonical posts require no redirect request',async()=>{
  for(const url of ['https://www.reddit.com/','https://pinterest.com/user/','https://xhslink.cn/'])await assert.rejects(resolveDownloadUrl(url),/publicação/);
  const result=await resolveDownloadUrl(examples[1],{lookup:()=>{throw new Error('unexpected network');}});
  assert.equal(result.url,'https://www.pinterest.com/pin/708261478933750684/');assert.equal(result.extractor,'Pinterest');
});
test('unresponsive DNS is bounded by cancellation',async()=>{
  const controller=new AbortController();const pending=resolveDownloadUrl(examples[0],{lookup:()=>new Promise(()=>{}),signal:controller.signal});controller.abort();await assert.rejects(pending,/Tempo esgotado/);
});
