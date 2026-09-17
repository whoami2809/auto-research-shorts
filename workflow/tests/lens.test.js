const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const html=fs.readFileSync(require('node:path').join(__dirname,'../../public/index.html'),'utf8');
const source=html.slice(html.indexOf('function lensDestination('),html.indexOf('// Garante PNG real'));
function setup({status=200,blocked=false,closed=false,cacheStatus=404}={}){
  const frame={blob:new Blob(['fixture'],{type:'image/png'}),lensStatus:{},lensFallback:{hidden:true},lensResult:{hidden:true},lensButton:{}};
  const popup={closed,location:{},close(){this.closed=true;}};
  const timers=new Map();let uploads=0,copies=0;
  const context=vm.createContext({Date,AbortController,Blob,
    extractedFrames:[frame],window:{location:{origin:'https://app.test'},open:(url)=>{assert.equal(url,'/lens-wait.html');return blocked?null:popup;}},
    showToast(){},setTimeout(fn,ms){timers.set(ms,fn);return ms;},clearTimeout(id){timers.delete(id);},
    framePng:async blob=>blob,
    fetch:async()=>({ok:cacheStatus===200}),
    authenticatedApiFetch:async(url,options)=>{uploads++;assert.equal(url,'/api/frame');assert.equal(options.headers['Content-Type'],'image/png');return {ok:status===200,status,json:async()=>({url:'/api/frame/'+'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()})};},
    navigator:{clipboard:{write:async()=>{copies++;}}},ClipboardItem:class{constructor(data){this.data=data;}}
  });
  vm.runInContext(source,context);
  return {context,frame,popup,timers,uploads:()=>uploads,copies:()=>copies,run:()=>context.openLensViaServer(frame.blob,0)};
}
test('Direct Lens submits only the selected PNG without backend, session or blank popup',async()=>{
  const s=setup();let submitted=0,removed=0;const children=[];
  s.context.File=File;s.context.DataTransfer=class{constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}};
  s.context.window.open=()=>{throw new Error('No blank popup allowed');};
  const form={appendChild:input=>children.push(input),remove:()=>removed++,submit(){submitted++;assert.equal(this.action,'https://lens.google.com/v3/upload');assert.equal(this.target,'_blank');assert.equal(this.rel,'noopener noreferrer');assert.equal(this.enctype,'multipart/form-data');assert.equal(this.method,'POST');}};
  s.context.document={createElement:tag=>tag==='form'?form:{},body:{appendChild(){}}};
  await s.context.openLens(s.frame.blob,0);
  assert.equal(submitted,1);assert.equal(removed,1);assert.equal(s.uploads(),0);assert.equal(s.copies(),0);assert.equal(children.length,1);assert.equal(children[0].name,'encoded_image');assert.equal(children[0].files[0].type,'image/png');assert.equal(await children[0].files[0].text(),'fixture');
});
test('Unsupported direct upload preserves the authenticated server alternative',async()=>{
  const s=setup();await s.context.openLens(s.frame.blob,0);assert.equal(s.uploads(),1);assert.match(s.popup.location.href,/lens.google.com\/uploadbyurl/);
});
test('Lens successful upload navigates with selected image and always resets busy',async()=>{
  const s=setup();await s.run();assert.equal(s.uploads(),1);assert.match(s.popup.location.href,/lens.google.com\/uploadbyurl/);assert.equal(s.frame.lensBusy,false);assert.equal(s.frame.lensButton.disabled,false);assert.equal(s.timers.size,0);assert.equal(s.copies(),0);
});
test('Lens preserves HTTP failure and offers fresh-click copy without automatic clipboard access',async()=>{
  for(const status of [401,413,503]){const s=setup({status});await s.run();assert.equal(s.frame.lensFallback.hidden,false);assert.equal(s.frame.lensBusy,false);assert.equal(s.copies(),0);assert.equal(s.popup.location.href,'/lens-wait.html#failed');assert.match(s.frame.lensStatus.textContent,status===401?/sessão/:status===413?/10 MB/:/503/);await s.context.copyLensFrame(s.frame);assert.equal(s.copies(),1);}
});
test('Lens aborts even if session promise ignores signal and does not navigate on late completion',async()=>{
  const s=setup();let finish;
  s.context.authenticatedApiFetch=()=>new Promise(resolve=>{finish=resolve;});
  const pending=s.run();await new Promise(resolve=>setImmediate(resolve));
  s.timers.get(90000)();await pending;
  assert.equal(s.frame.lensBusy,false);assert.equal(s.popup.location.href,'/lens-wait.html#failed');
  finish({ok:true,json:async()=>({url:'/api/frame/'+'a'.repeat(64),expires_at:new Date(Date.now()+60000).toISOString()})});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(s.popup.location.href,'/lens-wait.html#failed');assert.equal(s.frame.lensResult.hidden,true);
});
test('Lens keeps a direct image search link when the original popup was closed',async()=>{
  const s=setup({closed:true});await s.run();assert.equal(s.frame.lensResult.hidden,false);assert.match(s.frame.lensResult.href,/lens.google.com\/uploadbyurl/);
});
test('Lens popup blocked prevents image transfer',async()=>{
  const s=setup({blocked:true});await s.run();assert.equal(s.uploads(),0);assert.match(s.frame.lensStatus.textContent,/pop-ups/);
});
test('Lens evicted cached image is uploaded again and closed popup never reports success',async()=>{
  const s=setup({closed:true});s.frame.lensUrl='https://app.test/api/frame/'+'b'.repeat(64);s.frame.lensExpiresAt=Date.now()+60000;await s.run();assert.equal(s.uploads(),1);assert.match(s.frame.lensStatus.textContent,/fechada/);assert.equal(s.frame.lensBusy,false);
});
test('Lens waits beyond ten seconds and timeout restores retry controls',async()=>{
  const s=setup();s.context.authenticatedApiFetch=async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{const error=new Error();error.name='AbortError';reject(error);}));
  const pending=s.run();await new Promise(resolve=>setImmediate(resolve));
  s.timers.get(10000)();assert.equal(s.frame.lensBusy,true);assert.match(s.frame.lensStatus.textContent,/90 segundos/);
  s.timers.get(90000)();await pending;assert.equal(s.frame.lensBusy,false);assert.equal(s.frame.lensButton.disabled,false);assert.match(s.frame.lensStatus.textContent,/demorou/);assert.equal(s.copies(),0);
});
