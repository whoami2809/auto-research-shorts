const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../../public/index.html'),'utf8');
const start=app.indexOf('// ─── Multi-download');
const script=app.slice(start,app.indexOf('function initDownloadPanel()',start));
function setup(count){
  const nodes={},toasts=[],requests=[];
  const element=()=>({style:{},value:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},appendChild(){},click(){},remove(){},focus(){}});
  const get=id=>nodes[id]||(nodes[id]=element());
  const links=Array.from({length:count},(_,i)=>'https://xhslink.cn/o/test'+i);
  get('multiUrls').value=links.join('\n');get('multiQuality').value='max';
  class MockURL extends URL {}
  MockURL.createObjectURL=()=> 'blob:test';MockURL.revokeObjectURL=()=>{};
  const scope=vm.createContext({URL:MockURL,document:{getElementById:get,createElement:element,body:element()},navigator:{clipboard:{readText:async()=>links.join('\n')}},showToast:message=>toasts.push(message),setTimeout:fn=>fn(),downloadFilename:()=> 'test.mp4',authenticatedApiFetch:async url=>{requests.push(url);return {ok:true,blob:async()=>({})};}});
  vm.runInContext(script,scope);
  return {get,requests,toasts};
}
test('batch accepts 50 links and processes every item using mocked downloads',async()=>{
  const s=setup(50);await s.get('multiStart').listeners.click();
  assert.equal(s.requests.length,50);assert.equal(s.get('multiStart').disabled,false);
});
test('batch rejects 51 links before any download',async()=>{
  const s=setup(51);await s.get('multiStart').listeners.click();
  assert.equal(s.requests.length,0);assert.match(s.toasts[0],/máximo 50/);
});
test('clipboard preserves all 50 links and does not silently discard overflow',async()=>{
  for(const count of [50,51]){
    const s=setup(count);s.get('multiUrls').value='';await s.get('multiPasteBtn').listeners.click();
    assert.equal(s.get('multiUrls').value.split('\n').length,count);assert.equal(s.requests.length,0);
  }
});
