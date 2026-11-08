'use strict';
const assert=require('assert').strict, net=require('net'), crypto=require('crypto');
const {Bridge,devices}=require('../service/physical-input.js');
const remote='N: Name="Smart Control"\nH: Handlers=event4\n';
assert.equal(devices(remote)[0].selectable,true);
assert.equal(devices(remote+'\n'+remote)[0].unique,false);
assert.equal(devices('N: Name="panel key device"\nH: Handlers=event3\n')[0].selectable,false);
(async function(){
 let socket, bridge, commands=[], got=[], bad=false;
 function execute(cmd){commands.push(cmd);if(cmd==='cat /proc/bus/input/devices')return Promise.resolve({exit_code:0,stdout:remote});
  const secret=Buffer.from(/printf %s '([^']+)'/.exec(cmd)[1],'base64');
  const port=Number(/'127.0.0.1' '(\d+)'/.exec(cmd)[1]);
  socket=net.connect(port,'127.0.0.1');socket.on('error',()=>{});
  socket.once('data',chunk=>{const nonce=Buffer.from(chunk.toString().trim().split('\t')[1],'hex');
   function send(payload){const mac=crypto.createHmac('sha256',secret).update(nonce).update(Buffer.from([0])).update(payload).digest('hex');socket.write(payload+'\t'+(bad?'0'.repeat(64):mac)+'\n');}
   const b=s=>Buffer.from(s).toString('base64');send(['AUTH','123','0','0',b('Smart Control'),b('/dev/input/event4'),b('evdev'),b('TV'),'observe'].join('\t'));
   if(!bad)setTimeout(()=>{send('EVENT\t1\t'+b(JSON.stringify({type:1,code:67,sequence:1,device:'Smart Control',node:'/dev/input/event4',action:'down',decision:'native'})));
    send('STATE\t'+b(JSON.stringify({event:'state',node:'/dev/input/event4',dropped:2,source:[67],forwarded:[],tracked:[],stuck:true,changed:true})));
    send('EVENT\t2\t'+b(JSON.stringify({type:1,code:67,sequence:2,device:'Smart Control',node:'/dev/input/event4',action:'up',decision:'native'})))},20);
  });return Promise.resolve({exit_code:0});
 }
 bridge=new Bridge(execute,e=>got.push(e));
 try{
  const r=await bridge.start('Smart Control','observe',[]);assert.equal(r.policy.connected,true);
  await new Promise(r=>setTimeout(r,60));assert.equal(got[0].code,67);
  // STATE frames carry the key-state self-check; they sit outside the EVENT sequence.
  assert.equal(got.length,2);const st=bridge.status();assert.equal(st.diagnostics.stuck,true);assert.equal(st.diagnostics.dropped,2);assert.equal(st.diagnosticLog.length,1);
  assert.ok(commands.some(c=>/>>'\/tmp\/vetro-input-event4\.log' 2>&1 &$/.test(c)),'per-node appended helper log');
  bridge.stop();assert.equal(bridge.status().policy.mode,'off');
  await assert.rejects(bridge.start('Smart Control','filter',[]),/physical rule/);
  bad=true;await assert.rejects(bridge.start('Smart Control','observe',[]),/authentication/);assert.equal(bridge.status().policy.mode,'off');
  assert.equal(commands.filter(x=>x.includes('nohup')).length,2);
  console.log('PASS physical input: exact devices, authenticated events, state frames, per-node log, stop, reject invalid MAC');
 }finally{bridge.stop();if(socket)socket.destroy();}
})().catch(e=>{console.error(e);process.exitCode=1});
