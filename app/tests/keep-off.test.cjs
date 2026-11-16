'use strict';
const assert = require('assert').strict;
require('../service/compat.js').install();
const K = require('../service/keep-off.js');
const T0 = 1794900000; // 2026-11-17 (any time after MIN_CLOCK)

function out(o) {
  return ['__NOW__', o.now, '__DIR__', o.dir, '__FLAGS__'].concat(o.flags, ['__APPS__'],
    Object.keys(o.apps).map(id => [id].concat(o.apps[id]).join('|'))).join('\r\n') + '\n';
}
const pisaApps = installed => ({
  'com.samsung.tv.pisa-service': ['com.samsung.tv.pisa-service', 'false', installed],
  'com.samsung.tv.adagent-service': ['com.samsung.tv.pisa-service', 'false', installed],
  'org.tizen.pisa-control-service': ['com.samsung.tv.pisa-service', 'false', installed],
  'com.samsung.tv.acr': ['com.samsung.tv.acr', 'true', 180],
  'com.samsung.tv.coba.adagent': ['com.samsung.tv.coba.adagent', 'false', installed + 40],
  'kIciSQlYEM.plex': ['kIciSQlYEM', 'false', 200]
});
const saved = {at: T0, flags: ['bms', 'pisa-service'], apps: ['com.samsung.tv.acr', 'com.samsung.tv.adagent-service', 'com.samsung.tv.coba.adagent', 'com.samsung.tv.pisa-service', 'org.tizen.pisa-control-service']};

(async () => {
  // parse: CRLF, junk lines and IDs with shell characters are dropped.
  let cur = K.parse(out({now: T0, dir: 5, flags: ['bms', 'bad;rm'], apps: {'a.b': ['a', 'true', 7], 'x$(y)': ['x', 'true', 1]}}));
  assert.deepEqual(cur.flags, ['bms']);
  assert.deepEqual(Object.keys(cur.apps), ['a.b']);
  assert.deepEqual(cur.apps['a.b'], {pkg: 'a', disabled: true, installed: 7});

  // Before the clock is set nothing is decided: a 1970 "now" would make every install look new.
  assert.ok(K.decide(saved, K.parse(out({now: 49, dir: 0, flags: [], apps: pisaApps(1)}))).skip);
  assert.ok(K.decide(saved, K.parse(out({now: T0, dir: 0, flags: [], apps: {}}))).skip, 'empty package list');

  // No snapshot yet: record what is off, change nothing.
  let d = K.decide(null, K.parse(out({now: T0, dir: 1, flags: ['pisa-service', 'bms'], apps: pisaApps(100)})));
  assert.equal(d.seeded, true);
  assert.deepEqual(d.reapply, {apps: [], flags: []});
  assert.deepEqual(d.next, {at: T0, apps: ['com.samsung.tv.acr'], flags: ['bms', 'pisa-service']});

  // The S90C case of 2026-11-12: the pisa-service update enabled its three apps and deleted its flag 3 s later.
  const inst = T0 + 3600;
  d = K.decide(saved, K.parse(out({now: T0 + 7200, dir: inst + 3, flags: ['bms'], apps: pisaApps(inst)})));
  assert.deepEqual(d.reapply.apps, ['com.samsung.tv.adagent-service', 'com.samsung.tv.pisa-service', 'org.tizen.pisa-control-service']);
  assert.deepEqual(d.reapply.flags, ['pisa-service']);
  assert.ok(d.forgot.apps.includes('com.samsung.tv.coba.adagent'), 'the Smart Hub dependency is never disabled again');
  assert.ok(!d.reapply.apps.includes('com.samsung.tv.coba.adagent'));
  assert.deepEqual(d.next.flags, ['bms', 'pisa-service']);
  assert.ok(d.next.apps.includes('com.samsung.tv.pisa-service') && d.next.apps.includes('com.samsung.tv.acr'));
  assert.equal(d.next.at, T0 + 7200);

  // Switched on by the user (no install since the snapshot): accepted and forgotten, flag included.
  d = K.decide(saved, K.parse(out({now: T0 + 600, dir: T0 + 300, flags: ['bms'], apps: pisaApps(T0 - 86400)})));
  assert.deepEqual(d.reapply, {apps: [], flags: []});
  assert.ok(d.forgot.apps.includes('com.samsung.tv.pisa-service'));
  assert.deepEqual(d.forgot.flags, ['pisa-service']);
  assert.deepEqual(d.next.flags, ['bms']);
  assert.ok(!d.next.apps.includes('com.samsung.tv.pisa-service'));

  // A flag removed by hand long after some unrelated install is not put back.
  d = K.decide(saved, K.parse(out({now: T0 + 9000, dir: T0 + 8000, flags: ['bms'], apps: pisaApps(T0 + 100)})));
  assert.deepEqual(d.reapply.flags, []);
  assert.deepEqual(d.forgot.flags, ['pisa-service']);

  // Newly disabled apps and new flags join the snapshot; a removed package is forgotten.
  const more = pisaApps(T0 - 5); more['com.samsung.tv.new'] = ['n', 'true', 9]; delete more['com.samsung.tv.acr'];
  d = K.decide(saved, K.parse(out({now: T0 + 60, dir: 1, flags: ['bms', 'pisa-service', 'extra'], apps: more})));
  assert.ok(d.next.apps.includes('com.samsung.tv.new'));
  assert.ok(d.forgot.apps.includes('com.samsung.tv.acr'));
  assert.deepEqual(d.next.flags, ['bms', 'extra', 'pisa-service']);
  // The snapshot time never moves backwards.
  assert.equal(K.decide(saved, K.parse(out({now: T0 - 50, dir: 1, flags: [], apps: pisaApps(1)}))).next.at, T0);

  // The apply script: flag first, guarded units stopped without waiting, then pkgcmd with a read-back.
  const sh = K.applyScript({flags: ['pisa-service'], apps: ['com.samsung.tv.pisa-service']});
  assert.ok(sh.indexOf('touch ' + K.FLAG_DIR + '/pisa-service') < sh.indexOf('pkgcmd -D'));
  assert.ok(sh.includes("ConditionPathExists=!" + K.FLAG_DIR + "/pisa-service"));
  assert.ok(sh.includes('systemctl --no-block stop'));
  assert.ok(!/systemctl (start|restart)|app_launcher -s|pkgcmd -A/.test(sh), 'never starts or enables anything');
  assert.ok(sh.includes("app_disable FROM package_app_info WHERE app_id='com.samsung.tv.pisa-service'"));

  // Keeper.run end to end with a fake TV and file store.
  let file = JSON.stringify(saved), scripts = [], applyFails = false;
  const store = {readFileSync() { if (file === null) throw Error('absent'); return file; }, writeFileSync(p, t) { this.tmp = t; }, renameSync() { file = this.tmp; }};
  const tvOut = out({now: T0 + 7200, dir: inst + 3, flags: ['bms'], apps: pisaApps(inst)});
  const execute = async cmd => {
    scripts.push(cmd);
    if (cmd.startsWith('echo __NOW__')) return {exit_code: 0, stdout: tvOut};
    const body = Buffer.from(cmd.split(' ')[1], 'base64').toString();
    assert.ok(body.includes('pkgcmd -D'));
    return applyFails ? {exit_code: 1, stdout: 'not disabled: x'} : {exit_code: 0, stdout: ''};
  };
  let k = new K.Keeper(execute, store);
  applyFails = true;
  await assert.rejects(k.run(), /not disabled/);
  assert.equal(file, JSON.stringify(saved), 'a failed apply keeps the old snapshot, so the next pass retries');
  assert.ok(k.status().last.error);
  applyFails = false;
  const r = await k.run();
  assert.deepEqual(r.reapplied.flags, ['pisa-service']);
  const now = JSON.parse(file);
  assert.equal(now.at, T0 + 7200);
  assert.equal(now.log.length, 1);
  assert.deepEqual(now.log[0].reapplied.flags, ['pisa-service']);
  assert.ok(scripts[scripts.length - 1].endsWith('| base64 -d | sh'));
  // Nothing to do: one read, no apply, the log does not grow.
  scripts = [];
  const quiet = new K.Keeper(async cmd => { scripts.push(cmd); return {exit_code: 0, stdout: out({now: T0 + 7800, dir: inst + 3, flags: ['bms', 'pisa-service'], apps: Object.assign(pisaApps(inst), {'com.samsung.tv.pisa-service': ['com.samsung.tv.pisa-service', 'true', inst], 'com.samsung.tv.adagent-service': ['com.samsung.tv.pisa-service', 'true', inst], 'org.tizen.pisa-control-service': ['com.samsung.tv.pisa-service', 'true', inst]})}) }; }, store);
  const q = await quiet.run();
  assert.deepEqual(q.reapplied, {apps: [], flags: []});
  assert.equal(scripts.length, 1);
  assert.equal(JSON.parse(file).log.length, 1);
  console.log('keep-off: ok');
})().catch(e => { console.error(e); process.exit(1); });
