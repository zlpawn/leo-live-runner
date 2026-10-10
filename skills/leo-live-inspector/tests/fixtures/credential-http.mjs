// Route only business hosts to the test HTTP server; relay loopback stays real.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const request=http.request;
function route(options, callback) {
  const host=options.hostname || options.host;
  if (host && host.endsWith('.ke.com')) return request({...options,protocol:'http:',hostname:'127.0.0.1',port:Number(process.env.LEO_TEST_HTTP_PORT),headers:{...options.headers,'x-test-target':host}},callback);
  return request(options,callback);
}
https.request=route;
https.get=(options,callback)=>{const req=route(options,callback);req.end();return req;};
http.request=route;
syncBuiltinESMExports();
