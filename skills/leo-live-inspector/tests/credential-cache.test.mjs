import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const moduleUrl=new URL('../scripts/common/credentials.js',import.meta.url).href;
function readImported(fn,text){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'leo-cookie-scope-'));
 fs.writeFileSync(path.join(home,'cookies.txt'),text);
 try {
  const r=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(moduleUrl)});process.stdout.write(m.${fn}());`],{cwd:home,env:{...process.env,HOME:home,SHIPWRIGHT_COOKIE:'',CLOUD_COOKIE:''},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);return r.stdout;
 }finally{fs.rmSync(home,{recursive:true,force:true});}
}
test('downloaded cookies exclude sibling domains and respect path, secure and expiry',()=>{
 const future=Math.floor(Date.now()/1000)+3600;
 const text=[`feci-next.ke.com\tFALSE\t/\tTRUE\t${future}\tsid\twrong`,
  `.ke.com\tTRUE\t/\tTRUE\t${future}\tsso\tshared`,
  `shipwright.ke.com\tFALSE\t/private\tTRUE\t${future}\tprivate\tno`,
  `shipwright.ke.com\tFALSE\t/\tTRUE\t1\texpired\tno`,
  `#HttpOnly_shipwright.ke.com\tFALSE\t/\tTRUE\t${future}\tsid\tright`].join('\n');
 assert.equal(readImported('loadShipwrightCookie',text),'sso=shared; sid=right');
 assert.equal(readImported('loadCloudCookie',text),'sso=shared');
});
