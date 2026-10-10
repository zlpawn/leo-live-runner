import test from 'node:test';
import assert from 'node:assert/strict';
const mod=await import('../scripts/common/browser_credentials.js').catch(()=>({}));
const target='https://example.com/api';
const fresh=[{name:'sid',value:'new',domain:'example.com',path:'/'}];
function session(options={}) {assert.equal(typeof mod.createCredentialSession,'function');return mod.createCredentialSession(options);}
test('valid cached credential never asks browser',async()=>{
 const s=session({load:()=> 'sid=old',getCookies:()=>assert.fail('unexpected browser')});
 const res=await s.run(target,async cookie=>{assert.equal(cookie,'sid=old');return {statusCode:200};},{readOnly:true});assert.equal(res.statusCode,200);
});
test('missing credential obtained once and persisted only after success',async()=>{
 let saved;let gets=0;
 const s=session({load:()=>'',save:c=>saved=c,getCookies:async()=>{gets++;return fresh;}});
 await s.run(target,async c=>{assert.equal(saved,undefined);assert.equal(c,'sid=new');return {statusCode:200};},{readOnly:true});
 assert.equal(saved,'sid=new');assert.equal(gets,1);
});
test('expired cached credential refreshed once; failed candidate is never saved',async()=>{
 let calls=0,gets=0;
 const s=session({load:()=> 'sid=old',save:()=>assert.fail('bad cache write'),getCookies:async()=>{gets++;return fresh;}});
 const r=await s.run(target,async()=>{calls++;return {statusCode:401};},{readOnly:true});
 assert.equal(r.statusCode,401);assert.equal(calls,2);assert.equal(gets,1);
 await s.run(target,async()=>({statusCode:401}),{readOnly:true});assert.equal(gets,1);
});
test('ordinary failures, explicit overrides and anonymous success never read browser',async()=>{
 for(const statusCode of [403,500,504]) {
  const s=session({load:()=> 'sid=old',getCookies:()=>assert.fail('browser')});
  assert.equal((await s.run(target,async()=>({statusCode}),{readOnly:true})).statusCode,statusCode);
 }
 const explicit=session({load:()=> 'sid=manual',explicit:true,getCookies:()=>assert.fail('browser')});
 assert.equal((await explicit.run(target,async()=>({statusCode:401}),{readOnly:true})).statusCode,401);
 const anonymous=session({load:()=>'',anonymous:true,getCookies:()=>assert.fail('browser')});
 await anonymous.run(target,async c=>{assert.equal(c,'');return {statusCode:200};},{readOnly:true});
});
test('write is not replayed and missing credentials require read preflight',async()=>{
 let writes=0;
 const s=session({load:()=> 'sid=old',getCookies:()=>assert.fail('browser')});
 await s.run(target,async()=>({statusCode:200}),{readOnly:true});
 const r=await s.run(target,async()=>{writes++;return {statusCode:401};});assert.equal(r.statusCode,401);assert.equal(writes,1);
 await assert.rejects(session({load:()=>''}).run(target,async()=>assert.fail('write')), {code:'CREDENTIAL_PREFLIGHT_REQUIRED'});
});
test('new unverified candidate never reaches write after unsuccessful read',async()=>{
 const s=session({load:()=>'',getCookies:async()=>fresh});
 await s.run(target,async()=>({statusCode:500}),{readOnly:true});
 await assert.rejects(s.run(target,async()=>assert.fail('write')),{code:'CREDENTIAL_PREFLIGHT_REQUIRED'});
});
test('Apollo test-login redirect is an authentication failure',()=>{
 assert.equal(mod.isLoginFailure({statusCode:302,headers:{location:'https://test-login.ke.com/login?service=x'}}),true);
 assert.equal(mod.isLoginFailure({statusCode:302,headers:{location:'https://unrelated.test/next'}}),false);
});
test('missing status is not successful validation',()=>{
 assert.equal(mod.isCredentialSuccess({data:null}),false);
 assert.equal(mod.isCredentialSuccess({statusCode:200,data:{code:500,message:'failed'}}),false);
});
test('browser returning the same rejected credential does not replay request',async()=>{
 let sent=0;
 const s=session({load:()=> 'sid=new',getCookies:async()=>fresh});
 await assert.rejects(s.run(target,async()=>{sent++;return {statusCode:401};},{readOnly:true}),{code:'CREDENTIAL_REJECTED'});
 assert.equal(sent,1);
});
