'use strict';
// MQTT panel brightness: command topic -> verified avoc write, newest value wins, invalid payloads ignored.
const assert=require('assert').strict,path=require('path'),platform=require('../service/platform.js');
const SET='busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl SetBacklight ii ';
const GET='busctl --system call org.tizen.tv.avoc /org/tizen/tv/avoc org.tizen.tv.avoc.AvOutputControl GetBacklight i 0';
let value=20,stick=true;const commands=[];
platform.execute=c=>{commands.push(c);if(c===GET)return Promise.resolve({exit_code:0,stdout:'ii '+value+' 0\n'});if(c.startsWith(SET)){if(stick)value=+c.slice(SET.length).split(' ')[0];return Promise.resolve({exit_code:0,stdout:'i 0\n'});}return Promise.resolve({exit_code:0,stdout:''});};
const {context}=require('./service-harness.cjs')(path.resolve(__dirname,'..'));
const published=[],events=[];const bridge=context.bridge;bridge.backlightCommandTopic='vetro/tv/backlight/set';bridge.publishBacklight=v=>published.push(v);bridge.event=(t,m)=>events.push(t+': '+m);
const idle=()=>new Promise(r=>setTimeout(r,1300));
(async()=>{
 bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('35')});await idle();
 assert.equal(value,35);assert.deepEqual(published,[35],'requested value is echoed once; a matching readback adds nothing');assert.ok(commands.includes(SET+'35 1'),'brightness is written with the keep argument 1');
 commands.length=0;published.length=0;
 bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('10')});bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('11')});bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('12.0')});await idle();await idle();
 assert.equal(value,12);assert.deepEqual(published,[10,11,12],'every request is echoed at once, in order, and nothing older follows');assert.ok(!commands.includes(SET+'11 1'));
 published.length=0;stick=false;bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from('40')});await idle();await idle();
 assert.deepEqual(published,[40,12],'a value the TV does not keep is corrected with what it reports');stick=true;
 commands.length=0;for(const bad of ['51','-1','abc','','5;reboot'])bridge.onMessage({topic:'vetro/tv/backlight/set',payload:Buffer.from(bad)});await idle();
 assert.equal(commands.length,0,'invalid payloads never reach the TV');assert.ok(events.some(e=>/invalid value/.test(e)));
 console.log('PASS MQTT panel brightness: verified write, readback published, newest value wins, invalid payloads rejected');
})().catch(e=>{console.error(e);process.exitCode=1});
