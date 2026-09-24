// Uses the local Chrome DevTools endpoint; no dependencies or external requests.
// Start headless Chrome with --remote-debugging-port=9227 and a temporary profile.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pages = await fetch('http://127.0.0.1:9227/json/list').then(r => r.json());
const page = pages.find(p => p.type === 'page');
if (!page) throw new Error('No browser page found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve,reject) => { ws.onopen=resolve; ws.onerror=reject; });
let seq=0;
const pending=new Map(), errors=[];
ws.onmessage=e=>{ const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else if(m.method==='Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text+' '+(m.params.exceptionDetails.exception?.description||'')); };
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'Evaluation failed');return r.result.value;}
const pause = ms => new Promise(r=>setTimeout(r,ms));
await call('Page.enable');await call('Runtime.enable');
await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
const url=pathToFileURL(path.join(root,'index.html')).href;
async function go(hash){await call('Page.navigate',{url:'about:blank'});await call('Page.navigate',{url:url+'#'+hash});await pause(220);await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');}
const checks=[];
function assert(result,label){if(!result)throw Error(label);checks.push(label);}
await go('urls');
assert(await evaluate('document.querySelectorAll("tbody tr").length === 8'),'URL list paginates 15 seeded exclusions');
await evaluate(`document.querySelector('[data-action="next"]').click()`);
assert(await evaluate('document.querySelectorAll("tbody tr").length === 7'),'Second page shows the remaining 7 exclusions');
await evaluate(`document.querySelector('[data-action="new"]').click();document.querySelector('[name="param_key_regex"]').value='debug_id';document.querySelector('#url-form').requestSubmit()`);
await pause(50);
assert(await evaluate('db.urls.length === 16 && db.urls.at(-1).param_key_regex === "debug_id"'),'New URL exclusion saves in demo state');
await evaluate(`document.querySelector('#search').value='debug_id';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-action="toggle"]').click()`);
assert(await evaluate('db.urls.at(-1).is_active === false'),'URL exclusion can be disabled');
await evaluate(`document.querySelector('[data-action="delete"]').click();document.querySelector('[data-action="confirm-delete"]').click()`);
assert(await evaluate('db.urls.length === 15'),'Deletion requires confirmation and removes the exclusion');
await go('url-editor');
assert(await evaluate(`document.querySelector('#url-preview').textContent === 'https://shop.example/chairs?category=garden'`),'URL preview removes tracking parameters and retains functional parameters');
await go('referrers');
await evaluate(`document.querySelector('[data-action="new"]').click();document.querySelector('[name="hosts"]').value='https://invalid.example/path';document.querySelector('#ref-form').requestSubmit()`);
assert(await evaluate('document.querySelector("#ref-error").textContent.length>0'),'Referrer editor rejects URLs instead of hosts');
await evaluate(`document.querySelector('[name="hosts"]').value='checkout.example\\ncheckout.example\\nWWW.EXAMPLE.COM';document.querySelector('#ref-form').requestSubmit()`);
assert(await evaluate('db.refs.length===6 && db.refs.includes("www.example.com")'),'Bulk referrer input normalizes and deduplicates hosts');
await go('rule-editor');
await evaluate(`document.querySelector('[name="set_source"]').value='instagram_demo';document.querySelector('#editor-form').requestSubmit()`);await pause(50);
assert(await evaluate('db.rules[0].set_source === "instagram_demo" && location.hash === "#rules"'),'Rule editor saves output fields and returns to rules');
await go('rule-editor');
await evaluate(`document.querySelector('[name="stage"]').value='channel';document.querySelector('[name="stage"]').dispatchEvent(new Event('change',{bubbles:true}))`);
assert(await evaluate('!!document.querySelector("[name=set_traffic_channel]") && !document.querySelector("[name=set_source]")'),'Stage selection exposes only applicable output fields');
await go('mapping-editor');
await evaluate(`document.querySelector('[name="entity"]').value='event';document.querySelector('[name="entity"]').dispatchEvent(new Event('change',{bubbles:true}))`);
assert(await evaluate('document.querySelector("[name=param_source]").value === "event_params"'),'Mapping entity controls the valid parameter container');
await evaluate(`document.querySelector('[name="priority"]').value='99';document.querySelector('#editor-form').requestSubmit()`);await pause(50);
assert(await evaluate('db.mappings[0].entity === "event" && db.mappings[0].param_source === "event_params" && location.hash === "#mappings"'),'Mapping editor saves entity, container, and priority consistently');
const shots=[['urls','01-url-parameters'],['url-editor','02-url-editor'],['referrers','03-referrers'],['rules','04-traffic-rules'],['rule-editor','05-rule-editor'],['mappings','06-attribution-signals'],['mapping-editor','07-signal-editor']];
await fs.mkdir(path.join(root,'screenshots'),{recursive:true});
for(const [hash,name] of shots){
 await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
 await go(hash);
 assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),hash+' has no page-level horizontal overflow at 1600px');
 await evaluate(`{const style=document.createElement('style');style.textContent='.prototype-bar,#toast{display:none!important}.sidebar{height:100vh}.workspace{margin-bottom:8px}';document.head.append(style);}`);
 const metrics=await call('Page.getLayoutMetrics');
 const height=hash==='url-editor'?1100:Math.ceil(Math.max(1100,metrics.cssContentSize.height));
 await call('Emulation.setDeviceMetricsOverride',{width:1600,height,deviceScaleFactor:1,mobile:false});
 await evaluate('new Promise(r => requestAnimationFrame(r))');
 const result=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:1600,height,scale:1}});
 await fs.writeFile(path.join(root,'screenshots',name+'.png'),Buffer.from(result.data,'base64'));
 console.log('Captured',name,1600,height);
}
await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
for(const [hash] of shots){await go(hash);assert(await evaluate('document.documentElement.scrollWidth <= innerWidth'),hash+' has no page-level horizontal overflow at 390px');}
assert(errors.length===0,'No browser JavaScript exceptions');
await fs.writeFile(path.join(root,'validation.txt'),checks.map(s=>'PASS '+s).join('\n')+'\n');
console.log(checks.length+' checks passed');
await call('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
await go('rules');
ws.close();
