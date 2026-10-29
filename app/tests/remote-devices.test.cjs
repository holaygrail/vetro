'use strict';
const assert=require('assert').strict, path=require('path'), EventEmitter=require('events');
const load=require('./service-harness.cjs'), root=path.resolve(__dirname,'..');
let disk=JSON.stringify({rules:[{id:'netflix',enabled:true,trigger:{type:'physical',value:'226'},actions:[{type:'launch',appId:'plex.app'}]},{id:'mute',enabled:true,trigger:{type:'physical',value:'113'},actions:[{type:'none'}]}],input:{enabled:true,device:'wt61p807 rc device',node:'/dev/input/event1'}});
const remotes=[{name:'wt61p807 rc device',node:'/dev/input/event1',unique:true,selectable:true},{name:'Smart Control',node:'/dev/input/event3',unique:true,selectable:true},{name:'wt61p807 panel key device',node:'/dev/input/event2',unique:true,selectable:false}];
const bridges=[], commands=[];
class Bridge {
 constructor(execute,onEvent){this.onEvent=onEvent;this.current={mode:'off',connected:false};bridges.push(this);}
 inventory(){return Promise.resolve(remotes);}
 status(){return {policy:this.current,events:[]};}
 stop(){this.current={mode:'off',connected:false};}
 async start(device,mode,tokens){const d=remotes.find(x=>x.node===device||x.name===device);this.current={mode,connected:true,device:d.name,node:d.node,blocked:tokens};return this.status();}
}
function boot(){const timers=[];const service=load(root,{dependencies:{fs:{readFileSync:p=>p.endsWith('vetro-remap.json')?disk:'',writeFileSync:(p,s)=>{disk=s;}},'./physical-input.js':{Bridge},'./platform.js':{start(){},status:()=>({agent:{connected:true}}),execute:cmd=>{commands.push(cmd);return Promise.resolve({exit_code:0,stdout:''});}}},setInterval:fn=>{timers.push(fn);return {unref(){}};}});service.tick=async()=>{timers.forEach(fn=>fn());for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));};return service;}
function get(service){return new Promise(resolve=>{const req=new EventEmitter();req.method='GET';req.url='/input';service.router(req,{writeHead(){},end(s){resolve(JSON.parse(s));}});});}
const launches=()=>commands.filter(c=>c.startsWith('/usr/bin/app_launcher'));
const active=()=>bridges.filter(b=>b.current.mode==='filter').map(b=>b.current.node).sort();
(async()=>{
 const service=await boot();await service.tick();
 assert.deepEqual(active(),['/dev/input/event1','/dev/input/event3'],'saved remote and Bluetooth remote are both intercepted, the panel is not');
 assert.ok(bridges.every(b=>b.current.mode!=='filter'||b.current.blocked.join()==='226,113'));
 const status=(await get(service)).status;assert.equal(status.policy.mode,'filter');assert.equal(status.policy.node,'/dev/input/event1');
 assert.equal(status.policy.device,'wt61p807 rc device + Smart Control');
 const ir=bridges.find(b=>b.current.node==='/dev/input/event1'), bt=bridges.find(b=>b.current.node==='/dev/input/event3');
 bt.onEvent({action:'down',decision:'blocked',code:226,node:'/dev/input/event3'});await service.context.actionQueue;
 assert.deepEqual(launches(),['/usr/bin/app_launcher -s plex.app'],'a Bluetooth press runs the shortcut');
 ir.onEvent({action:'down',decision:'blocked',code:226,node:'/dev/input/event1'});await service.context.actionQueue;
 assert.equal(launches().length,1,'the same press reported over IR right after Bluetooth runs once');
 bt.onEvent({action:'down',decision:'blocked',code:113,node:'/dev/input/event3'});await service.context.actionQueue;
 assert.equal(launches().length,1,'a "do nothing" rule only blocks the key');assert.equal(service.context.inputPaused,false);
 bt.stop();await service.tick();assert.deepEqual(active(),['/dev/input/event1','/dev/input/event3'],'a dropped extra helper reconnects without restarting the saved one');
 assert.equal(ir.current.mode,'filter');
 ir.stop();await service.tick();assert.deepEqual(active(),['/dev/input/event1','/dev/input/event3'],'losing the saved helper restarts all of them');
 assert.equal(bridges.filter(b=>b.current.mode==='filter').length,2,'no helper is left running twice');
 console.log('PASS remote devices: IR and Bluetooth intercepted together, duplicate press ignored, do-nothing rule, reconnection');
})().catch(e=>{console.error(e);process.exitCode=1;});
