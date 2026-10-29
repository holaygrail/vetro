'use strict';
const assert = require('assert').strict;
const path = require('path');
const loaded = require('./provider-harness.cjs')(path.resolve(__dirname,'..'));
const context = loaded.context, provider = loaded.provider;
let closes = 0, fail = false;
context.sdb = {connect: async () => ({}), exec: async (client, command) => {
  assert.equal(command,'shell:0 vd_appinstall testPkg /tmp/test.wgt');
  if (fail) throw new Error('disconnected'); return 'output';
}, close: () => {closes++;}};
async function main() {
  assert.equal(await provider.install('testPkg','/tmp/test.wgt'),'output'); assert.equal(closes,1);
  fail = true; await assert.rejects(provider.install('testPkg','/tmp/test.wgt'), error => error.submitted === null);
  assert.equal(closes,2);
  await assert.rejects(provider.install('bad;id','/tmp/test.wgt'),/invalid/);
  provider.start(); provider.start(); assert.equal(provider.status().running,true);
  provider.stop(); assert.equal(provider.status().running,false);
  let timers=0; context.setTimeout = () => {timers++;}; context.scheduleRelaunch(); assert.equal(timers,0);
  const commands=require('../service/debloat-commands.js');
  assert.throws(() => commands.disableCommand(['com.samsung.tv.coba.adagent.service']),/Smart Hub/);
  assert.ok(commands.enableCommand(['com.samsung.tv.coba.adagent']));
  const detach=provider.detachCommand(4277);
  assert.match(detach,/echo 4277 > \/sys\/fs\/cgroup\/\$h\/vetro\/cgroup\.procs/);assert.match(detach,/for h in systemd unified/);
  for (const bad of [0,'',null,undefined,'12;reboot','-1',12.5]) assert.equal(provider.detachCommand(bad),null);
  console.log('PASS platform adapter: installer cleanup, unknown outcome, lifecycle, Smart Hub protection and agent cgroup detach');
}
main().catch(error => {console.error(error);process.exitCode=1;});
