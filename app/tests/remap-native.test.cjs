'use strict';
const assert=require('assert').strict,EventEmitter=require('events'),path=require('path');
const platform=require('../service/platform.js');
const commands=[];platform.execute=cmd=>{commands.push(cmd);return Promise.resolve({exit_code:0,stdout:''});};
const router=require('./service-harness.cjs')(path.resolve(__dirname,'..')).router;
function post(url,body){return new Promise(resolve=>{const req=new EventEmitter();req.method='POST';req.url=url;const res={writeHead(n){this.status=n},end(s){resolve({status:this.status,data:JSON.parse(s)})}};router(req,res);req.emit('data',Buffer.from(JSON.stringify(body)));req.emit('end');});}
(async()=>{
 const rule={id:'physical',trigger:{type:'physical',value:'068'},actions:[{type:'launch',appId:'app.selected'},{type:'key',key:'KEY_ENTER'}]};
 assert.equal((await post('/remap',{rules:[rule]})).data.rules[0].trigger.value,'68');
 const result=await post('/remap/run',{type:'physical',value:'68'});
 assert.equal(result.data.transport,'native');assert.equal(result.data.sent,2);
 assert.deepEqual(commands,['/usr/bin/app_launcher -s app.selected','/usr/bin/input_keyevent Return']);
 assert.equal((await post('/remap',{rules:[{...rule,trigger:{type:'physical',value:'768'}}]})).status,400);
 commands.length=0;assert.equal((await post('/remap',{rules:[{id:'pmode',trigger:{type:'physical',value:'226'},actions:[{type:'key',key:'KEY_PMODE'}]}]})).status,200);
 assert.equal((await post('/remap/run',{type:'physical',value:'226'})).data.sent,1);assert.deepEqual(commands,['/usr/bin/input_keyevent XF86PictureMode'],'KEY_PMODE sends the picture mode key');
 commands.length=0;assert.equal((await post('/remap',{rules:[{id:'livetv',trigger:{type:'physical',value:'226'},actions:[{type:'key',key:'KEY_TV'}]}]})).status,200);
 assert.equal((await post('/remap/run',{type:'physical',value:'226'})).data.sent,1);assert.deepEqual(commands,['/usr/bin/input_keyevent XF86DiscretSourceTV'],'KEY_TV switches to live TV');
 commands.length=0;const saved=await post('/remap',{rules:[{id:'ch',trigger:{type:'physical',value:'626'},actions:[{type:'channel',number:'104'}]}]});assert.equal(saved.status,200);assert.deepEqual(saved.data.rules[0].actions,[{type:'channel',number:104}],'channel number is stored as an integer');
 assert.equal((await post('/remap/run',{type:'physical',value:'626'})).data.sent,1);assert.equal(commands.length,1);
 assert.match(commands[0],/sqlite3 -readonly "\$p" "select srvId from SRV where major=104 and hidden=0 order by minor limit 1"/,'service ID is read from the channel database at press time');
 assert.match(commands[0],/\/usr\/bin\/launch_app org\.tizen\.tv-viewer svcid "\$id"$/,'tv-viewer tunes the service');
 for(const bad of [0,10000,'1;reboot',1.5,null])assert.equal((await post('/remap',{rules:[{id:'ch',trigger:{type:'physical',value:'626'},actions:[{type:'channel',number:bad}]}]})).status,400,'rejects channel '+bad);
 console.log('PASS native remap: canonical physical codes, selected app, whitelisted native key, picture mode, live TV key and direct channel tuning');
})().catch(e=>{console.error(e);process.exitCode=1});
