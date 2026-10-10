import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const relay = await import('../scripts/credential_relay.js').catch(() => ({}));
const extension = await import('../resources/chrome_extension/credential-relay.mjs').catch(() => ({}));
const base = 'http://127.0.0.1:19528';
const headers = {'Content-Type':'application/json','X-Leo-Credential-Relay':'1'};
async function post(path, body, extra = {}) {
  return fetch(base + '/credential-relay/' + path, {method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
}
async function ready() {
  for (let i=0;i<80;i++) {
    try { const r=await post('poll',{}, {Origin:'https://untrusted.test'}); if(r.status===403) return; } catch {}
    await delay(5);
  }
  assert.fail('relay did not listen');
}
const cookie={name:'sid',value:'test-secret',domain:'example.com',path:'/',secure:true,httpOnly:true,hostOnly:true,session:true};
test('relay and real extension client deliver filtered cookies then release port', async () => {
  assert.equal(typeof relay.getBrowserCookies,'function');
  assert.equal(typeof extension.createCredentialRelayClient,'function');
  const pending=relay.getBrowserCookies({url:'https://example.com/api?private=1#x',names:['sid'],timeoutMs:1000});
  await ready();
  const client=extension.createCredentialRelayClient({chromeApi:{cookies:{getAll:async details=>{
    assert.deepEqual(details,{url:'https://example.com/api'}); return [cookie,{...cookie,name:'other',value:'not-selected'}];
  }}},fetchImpl:fetch});
  await client.poll();
  assert.deepEqual(await pending,[cookie]);
  await assert.rejects(post('poll',{}));
});
test('timeout and abort both close listener', async () => {
  assert.equal(typeof relay.getBrowserCookies,'function');
  await assert.rejects(relay.getBrowserCookies({url:'https://example.com',timeoutMs:25}),{code:'RELAY_TIMEOUT'});
  const controller=new AbortController();
  const p=relay.getBrowserCookies({url:'https://example.com',timeoutMs:1000,signal:controller.signal});
  const rejected=assert.rejects(p,{code:'CANCELLED'});
  await ready(); controller.abort(); await rejected;
  await assert.rejects(post('poll',{}));
});
test('web origins cannot claim; wrong result id cannot finish task', async () => {
  assert.equal(typeof relay.getBrowserCookies,'function');
  const p=relay.getBrowserCookies({url:'https://example.com/api',timeoutMs:1000});
  await ready();
  assert.equal((await post('poll',{}, {Origin:'null'})).status,403);
  assert.equal((await post('result',{id:'wrong',cookies:[cookie]})).status,409);
  const {task}=await (await post('poll',{})).json();
  assert.equal(task.url,'https://example.com/api');
  await post('result',{id:task.id,cookies:[cookie]});
  assert.deepEqual(await p,[cookie]);
});
test('rejects invalid targets and does not steal occupied port', async () => {
  assert.equal(typeof relay.getBrowserCookies,'function');
  for(const url of ['', 'file:///tmp/x','https://user:pass@example.com'])
    await assert.rejects(relay.getBrowserCookies({url}),{code:'INVALID_REQUEST'});
  const s=http.createServer(); await new Promise(r=>s.listen(19528,'127.0.0.1',r));
  try {await assert.rejects(relay.getBrowserCookies({url:'https://example.com',timeoutMs:500}),{code:'RELAY_BUSY'});assert.equal(s.listening,true);}
  finally {await new Promise(r=>s.close(r));}
});

// CLI coverage lives in this file to serialize use of the fixed relay port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const skill=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function runBusiness(script,args,handler,browserCookie,seed={}) {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'leo-relay-cli-'));
 const dir=path.join(home,'.shrimp/skills/live-inspector');fs.mkdirSync(dir,{recursive:true});
 for(const [file,data] of Object.entries(seed)) fs.writeFileSync(path.join(file.endsWith('.txt') ? home : dir,file), typeof data === 'string' ? data : JSON.stringify(data));
 const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={...process.env,HOME:home,LEO_TEST_HTTP_PORT:String(server.address().port)};
 for(const key of ['CLOUD_MYSQL_TOKEN','CLOUD_CONSOLE_TOKEN','CLOUD_COOKIE','SHIPWRIGHT_COOKIE','FECI_COOKIE','APOLLO_TEST_COOKIE','DINSIGHT_TOKEN','DINSIGHT_COOKIE','PAODING_COOKIE','LEO_INSPECTOR_BROWSER_CREDENTIALS']) delete env[key];
 const child=spawn(process.execPath,['--import',path.join(skill,'tests/fixtures/credential-http.mjs'),path.join(skill,'scripts',script),...args],{env,cwd:home});
 let stdout='',stderr='',reads=0;
 child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 const client=extension.createCredentialRelayClient({chromeApi:{cookies:{getAll:async details=>{
   reads++;return typeof browserCookie==='function'?browserCookie(details):browserCookie || [];
 }}},fetchImpl:fetch});
 const timer=setInterval(()=>void client.poll(),10);
 const kill=setTimeout(()=>child.kill(),5000);
 try {
  const status=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  return {status,stdout,stderr,reads,cache:file=>JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'))};
 } finally {clearInterval(timer);clearTimeout(kill);await new Promise(r=>server.close(r));}
}
function jsonReply(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
test('Paoding CLI succeeds anonymously without starting browser retrieval',async()=>{
 const r=await runBusiness('test_log_query.js',['iot','--format','json'],(req,res)=>{
  assert.equal(req.headers.cookie || '','');jsonReply(res,200,{results:{A:{frames:[]}}});
 });assert.equal(r.status,0,r.stderr);assert.equal(r.reads,0);
});
test('Cloud MySQL CLI obtains and saves missing token without leaking its value',async()=>{
 const value='cloud-test-value';
 const r=await runBusiness('cloud_mysql_query.js',['recorder','SELECT 1','--json'],(req,res)=>{
  assert.equal(req.headers.cookie,`cloud_console_token_egg=${value};`);
  jsonReply(res,200,{code:200000,data:[]});
 },[{...cookie,name:'cloud_console_token_egg',value,domain:'cloud.intra.ke.com'}]);
 assert.equal(r.reads,1,r.stderr);assert.equal(r.cache('cloud_token.json').cloud_console_token_egg,value);
 assert.ok(!r.stdout.includes(value)&&!r.stderr.includes(value));
});
test('Dinsight whoami fetches cookies for the actual authentication API path',async()=>{
 const r=await runBusiness('dinsight_query.js',['--whoami'],(req,res)=>{
  assert.equal(req.url,'/api/v1/auth/me');jsonReply(res,200,{ucid:'test-user'});
 },details=>{assert.equal(details.url,'https://api-dinsight.ke.com/api/v1/auth/me');return [{...cookie,name:'prd-assistant-token-prod',domain:'api-dinsight.ke.com'}];});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,1);assert.match(r.stdout,/test-user/);
});
test('Apollo dry run refreshes expired login via test-login redirect once',async()=>{
 let calls=0;
 const r=await runBusiness('apollo_modify.js',['iot','application','key','new'],(req,res)=>{
  calls++;
  if(req.headers.cookie==='jt_apollo_login_token=expired'){res.writeHead(302,{Location:'https://test-login.ke.com/login'});res.end();}
  else jsonReply(res,200,[{key:'key',value:'old'}]);
 },[{...cookie,name:'jt_apollo_login_token',value:'fresh',domain:'test-apollo.portal.life.ke.com',secure:false}],{'test_apollo_cookie.json':{cookie:'jt_apollo_login_token=expired'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,1);assert.equal(calls,2);assert.match(r.stdout,/old/);
});
test('FeCI search receives its own Cookie and never the cloud Cookie',async()=>{
 const r=await runBusiness('feci_deploy.js',['--search','demo'],(req,res)=>{
  assert.equal(req.headers['x-test-target'],'feci-next.ke.com');
  assert.equal(req.headers.cookie,'sid=feci-fresh');jsonReply(res,200,{code:0,data:[]});
 },[{...cookie,value:'feci-fresh',domain:'feci-next.ke.com'}],{'cloud_token.json':{cookie:'sid=cloud-only'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,1);assert.equal(r.cache('feci_cookie.json').cookie,'sid=feci-fresh');
});
test('Shipwright discovery obtains a separate cookie rather than reusing cloud cache',async()=>{
 const hosts=[];
 const r=await runBusiness('ci_deploy.js',['unknown-relay-service','--dry-run'],(req,res)=>{
  const host=req.headers['x-test-target'];hosts.push(host);
  if(host==='shipwright.ke.com') {assert.equal(req.headers.cookie,'sid=ship-only');jsonReply(res,200,{list:[]});}
  else {assert.equal(req.headers.cookie,'sid=cloud-only');jsonReply(res,200,{data:[]});}
 },[{...cookie,value:'ship-only',domain:'shipwright.ke.com'}],{'cloud_token.json':{cookie:'sid=cloud-only'}});
 assert.equal(r.reads,1,r.stderr);assert.ok(hosts.includes('shipwright.ke.com'));assert.ok(hosts.includes('cloud.intra.ke.com'));
 assert.equal(r.cache('shipwright_cookie.json').cookie,'sid=ship-only');
});
test('FeCI business code 4000 refreshes expired cached cookie',async()=>{
 let attempts=0;
 const r=await runBusiness('feci_deploy.js',['--search','demo'],(req,res)=>{
  attempts++;
  jsonReply(res,200,req.headers.cookie==='sid=expired'?{code:4000,message:'not logged in'}:{code:0,data:[]});
 },[{...cookie,value:'fresh',domain:'feci-next.ke.com'}],{'feci_cookie.json':{cookie:'sid=expired'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,1);assert.equal(attempts,2);
});
test('queued callers expire and abort without waiting for active relay',async()=>{
 const firstController=new AbortController();
 const first=relay.getBrowserCookies({url:'https://example.com',timeoutMs:1000,signal:firstController.signal});
 const firstRejected=assert.rejects(first,{code:'CANCELLED'});
 await ready();
 const began=Date.now();
 const second=relay.getBrowserCookies({url:'https://example.com',timeoutMs:25});
 const outcome=await Promise.race([second.then(()=> 'resolved',e=>e.code),delay(150).then(()=> 'still-waiting')]);
 firstController.abort();await firstRejected;
 await second.catch(()=>{});
 assert.equal(outcome,'RELAY_TIMEOUT');assert.ok(Date.now()-began<500);
});
test('Paoding auth failure reuses manual cache before asking browser',async()=>{
 let calls=0;
 const r=await runBusiness('test_log_query.js',['iot','--format','json'],(req,res)=>{
  calls++;
  if(!req.headers.cookie) jsonReply(res,401,{message:'login'});
  else {assert.equal(req.headers.cookie,'sid=manual');jsonReply(res,200,{results:{A:{frames:[]}}});}
 },[],{'paoding_cookie.json':{cookie:'sid=manual'}});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,0);assert.equal(calls,2);
});
test('Cloud catalog discovery obtains missing token before resolving database names',async()=>{
 const r=await runBusiness('cloud_mysql_query.js',['--list-dbs'],(req,res)=>{
  assert.match(req.headers.cookie,/cloud_console_token_egg=/);
  jsonReply(res,200,{code:200000,data:req.url.includes('query_port')?['9999']:['relay_demo_database']});
 },[{...cookie,name:'cloud_console_token_egg',domain:'cloud.intra.ke.com'}]);
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,1);assert.match(r.stdout,/relay_demo_database/);
});

test('Cloud MySQL prefers verified cache over old exported Cookie files',async()=>{
 const r=await runBusiness('cloud_mysql_query.js',['--list-dbs'],(req,res)=>{
  assert.equal(req.headers.cookie,'cloud_console_token_egg=verified;');
  jsonReply(res,200,{code:200000,data:req.url.includes('query_port')?['9999']:['verified_database']});
 },[],{'cloud_token.json':{cloud_console_token_egg:'verified'},
 'cookies.txt':'cloud.intra.ke.com\tFALSE\t/\tTRUE\t0\tcloud_console_token_egg\tstale'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.reads,0);
 assert.equal(r.cache('cloud_token.json').cloud_console_token_egg,'verified');
});
test('extension idle polling never reads cookies and registers a minute alarm',async()=>{
 let listener;let polls=0;const created=[];
 const client=extension.createCredentialRelayClient({chromeApi:{
  cookies:{getAll:()=>assert.fail('idle must not read cookies')},
  alarms:{onAlarm:{addListener:fn=>listener=fn},get:async()=>undefined,create:async(...args)=>created.push(args)}
 },fetchImpl:async()=>{polls++;return {ok:true,json:async()=>({task:null})};}});
 await client.start();await delay(0);
 assert.deepEqual(created,[['credential_relay_poll',{periodInMinutes:1}]]);
 assert.equal(polls,1);listener({name:'credential_relay_poll'});await delay(0);assert.equal(polls,2);
});

test('CI deploy preflight gets credentials, then sends a rejected write only once',async()=>{
 let writes=0;let reads=0;
 const r=await runBusiness('ci_deploy.js',['smart-customer-service','--deploy-only','--image','test/image:relay'],(req,res)=>{
  assert.equal(req.headers.cookie,'sid=cloud-fresh');
  if(req.method==='GET') {reads++;jsonReply(res,200,{code:200000,data:{spec:{containers:[{image:'test/image:old'}]}}});}
  else {writes++;jsonReply(res,401,{code:401});}
 },[{...cookie,value:'cloud-fresh',domain:'cloud.intra.ke.com'}]);
 assert.equal(r.status,1);assert.equal(r.reads,1);assert.equal(reads,1);assert.equal(writes,1);
 assert.equal(r.cache('cloud_token.json').cookie,'sid=cloud-fresh');
});
test('relay filters sibling, expired, partitioned and mismatched-path cookies',async()=>{
 const pending=relay.getBrowserCookies({url:'https://example.com/api',timeoutMs:1000});await ready();
 const {task}=await (await post('poll',{})).json();
 const valid={...cookie,path:'/api'};
 await post('result',{id:task.id,cookies:[valid,{...cookie,domain:'other.example.com'},
  {...cookie,path:'/api/private'},{...cookie,expirationDate:1},{...cookie,partitionKey:{topLevelSite:'https://example.com'}}]});
 assert.deepEqual(await pending,[valid]);
});
test('queued cancellation does not open a listener after the active request ends',async()=>{
 const firstController=new AbortController();const queuedController=new AbortController();
 const first=relay.getBrowserCookies({url:'https://example.com',signal:firstController.signal});
 const firstRejected=assert.rejects(first,{code:'CANCELLED'});await ready();
 const queued=relay.getBrowserCookies({url:'https://example.com',signal:queuedController.signal});
 const queuedRejected=assert.rejects(queued,{code:'CANCELLED'});queuedController.abort();await queuedRejected;
 firstController.abort();await firstRejected;await delay(0);await assert.rejects(post('poll',{}));
});
test('opt-out does not start a relay',async()=>{
 const previous=process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS;
 try {process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS='off';
  await assert.rejects(relay.getBrowserCookies({url:'https://example.com'}),{code:'BROWSER_CREDENTIALS_DISABLED'});
  await assert.rejects(post('poll',{}));
 }finally {if(previous===undefined) delete process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS;else process.env.LEO_INSPECTOR_BROWSER_CREDENTIALS=previous;}
});
