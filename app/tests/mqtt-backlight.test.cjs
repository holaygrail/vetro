'use strict';
// Panel brightness sync: echo, newest-wins writes, event hints from the avocd signal helper, fallbacks.
const assert=require('assert').strict,net=require('net'),path=require('path');
const {BacklightSync,HINT}=require('../service/backlight-sync.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fake(){
 const tv={value:20,keep:true,reads:0,writes:[],delay:20};
 tv.store={readOne:async()=>{tv.reads++;return tv.value;},
  writeLatest:async(id,v)=>{await wait(tv.delay);tv.writes.push(v);const before=tv.value;if(tv.keep){tv.value=v;return {previous:before,value:v};}throw Error('Readback does not match');}};
 return tv;
}
(async()=>{
 // 1. Requests: echoed at once, newest wins, matching readback adds nothing, a refused value is corrected.
 {const tv=fake(),pub=[],ev=[];const s=new BacklightSync({store:tv.store,execute:async()=>({exit_code:0}),publish:v=>pub.push(v),event:(t,m)=>ev.push(m)});
  s.request('35');assert.deepEqual(pub,[35],'echo before the write finishes');await wait(60);assert.deepEqual(tv.writes,[35]);assert.deepEqual(pub,[35]);
  pub.length=0;tv.writes.length=0;s.request('10');s.request('11');s.request('12.0');await wait(120);
  assert.deepEqual(pub,[10,11,12],'every request echoed in order, nothing older follows');assert.deepEqual(tv.writes,[10,12],'only the newest waiting value is written');
  pub.length=0;tv.keep=false;s.request('40');await wait(60);assert.deepEqual(pub,[40,12],'value the TV does not keep is corrected');tv.keep=true;
  pub.length=0;for(const bad of ['51','-1','abc','','5;reboot'])assert.equal(s.request(bad),false);assert.equal(pub.length,0);assert.ok(ev.some(m=>/invalid value/.test(m)));}
 // 2. Hints: debounced to one read, published only on change, deferred while a write runs.
 {const tv=fake(),pub=[];const s=new BacklightSync({store:tv.store,execute:async()=>({exit_code:0}),publish:v=>pub.push(v),debounceMs:15});
  s.last=20;tv.value=0;s.hint();s.hint();s.hint();await wait(40);assert.equal(tv.reads,1,'burst of signals = one read');assert.deepEqual(pub,[0]);
  s.hint();await wait(40);assert.deepEqual(pub,[0],'unchanged value is not republished');
  pub.length=0;tv.delay=80;const reads=tv.reads;s.request('30');s.hint();await wait(40);assert.equal(tv.reads,reads,'no read while the write runs');
  tv.store.writeLatest=async(id,v)=>{await wait(10);tv.value=7;return {previous:30,value:v};};s.request('31');s.hint();await wait(150);
  assert.ok(tv.reads>=reads+1,'deferred signal is read after the write');assert.deepEqual(pub,[30,31,7],'value changed meanwhile (picture mode) is published after the write');}
 assert.ok(HINT.test('/org/tizen/tv/avoc: org.tizen.tv.avoc.AvOutputControl.PictureModeChanged (65538,)'));
 assert.ok(HINT.test('/org/tizen/tv/avoc: org.tizen.tv.avoc.AvOutputControl.BacklightChanged ()'));
 assert.ok(!HINT.test('/org/tizen/tv/avoc: org.tizen.tv.avoc.AvOutputControl.ContrastChanged ()'));
 // 3. Helper: real loopback socket; signal lines trigger a read, a lost helper is relaunched, stop ends it.
 {const tv=fake(),pub=[],cmds=[];let port=null;
  const s=new BacklightSync({store:tv.store,publish:v=>pub.push(v),debounceMs:10,backoffMs:30,
   execute:async c=>{cmds.push(c);const m=/dev\/tcp\/127\.0\.0\.1\/(\d+)/.exec(c);if(m)port=+m[1];return {exit_code:0};}});
  try{s.start();await wait(50);
  assert.ok(port,'helper command names the loopback port');const cmd=cmds.find(c=>c.includes('gdbus monitor'));
  assert.match(cmd,/gdbus monitor --system --dest org\.tizen\.tv\.avoc --object-path \/org\/tizen\/tv\/avoc/);assert.match(cmd,/grep -q "gdbus monitor"; then kill \$old/,'old helper ended only if it is a gdbus monitor');
  let sock=net.connect(port,'127.0.0.1');await wait(40);assert.equal(s.status().helperConnected,true);
  pub.length=0;tv.reads=0;tv.value=15;sock.write('Monitoring signals on object /org/tizen/tv/avoc owned by org.tizen.tv.avoc\n/org/tizen/tv/avoc: org.tizen.tv.avoc.AvOutputControl.PictureModeChanged (65538,)\n');await wait(40);
  assert.deepEqual(pub,[15],'picture mode change reaches MQTT');
  const launches=cmds.filter(c=>c.includes('gdbus monitor')).length;port=null;sock.destroy();await wait(120);
  assert.ok(cmds.filter(c=>c.includes('gdbus monitor')).length>launches&&port,'helper relaunched after it ended');
  sock=net.connect(port,'127.0.0.1');await wait(30);assert.equal(s.status().helperConnected,true);
  s.stop();await wait(20);assert.ok(cmds[cmds.length-1].includes('rm -f /tmp/vetro-avoc-monitor.pid'));assert.equal(s.status().running,false);sock.destroy();}finally{s.stop();}}
 // 4. Service wiring: the command topic reaches the sync, the 10-second state timer no longer polls brightness.
 {const platform=require('../service/platform.js');const cmds=[];platform.execute=c=>{cmds.push(c);return Promise.resolve({exit_code:0,stdout:'ii 9 0\n'});};
  const {context}=require('./service-harness.cjs')(path.resolve(__dirname,'..'),{setInterval:()=>1});
  const got=[];context.backlight.request=p=>got.push(p);context.bridge.backlightCommandTopic='vetro/tv/backlight/set';
  context.bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('22')});assert.deepEqual(got,['22']);}
 console.log('PASS panel brightness sync: echo, newest-wins writes, correction, debounced signal hints, deferred reads, helper relaunch and stop');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>setTimeout(()=>process.exit(),50));
