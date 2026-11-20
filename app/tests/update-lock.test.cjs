'use strict';
const assert = require('assert').strict;
require('../service/compat.js').install();
const L = require('../service/update-lock.js');

// A small TV: Auto update, the units with load/active state, the boot id. Scripts are read, not run.
function tv(start) {
  const s = Object.assign({autoupdate: 1, fws: null, boot: '11111111-2222-3333-4444-555555555555', refuseMask: [], scripts: [],
    timeout: null, refuseVconf: false, failReads: 0}, start);
  s.units = {};
  L.UNITS.forEach(u => { s.units[u] = {load: 'loaded', active: /timer|path/.test(u) || u === 'swu-auto-upgrade.service' ? 'active' : 'inactive'}; });
  delete s.units['bootmode-system-update.service'];   // a unit this firmware lacks
  const execute = async cmd => {
    const sh = Buffer.from(cmd.split(' ')[1], 'base64').toString();
    s.scripts.push(sh);
    if (sh.includes('echo "AU|') && s.failReads > 0) { s.failReads--; throw Error('TV is busy'); }
    if (sh.includes('echo "AU|')) {
      const lines = ['AU|' + (s.autoupdate === null ? 'Error' : 'db/menu/support/softwareupdate/autoupdate, value = ' + s.autoupdate + ' (Int32)'),
        'FWS|' + (s.fws === null ? 'Error: Get: no such key' : 'x, value = ' + s.fws + ' (Int32)'), 'BOOT|' + s.boot];
      L.UNITS.forEach(u => { lines.push('LS|' + u + '|' + (s.units[u] ? s.units[u].load : 'not-found') + '|' + (s.units[u] ? s.units[u].active : 'inactive')); });
      return {exit_code: 0, stdout: lines.join('\n') + '\n'};
    }
    if (/systemctl stop --no-block \$u/.test(sh)) {
      const m = /for u in ([^;]+); do systemctl stop/.exec(sh);
      m[1].trim().split(' ').forEach(u => { if (s.units[u]) s.units[u].active = 'inactive'; });
    }
    // timeout: {match, applied}: the call times out; with applied the TV still did the work.
    const timedOut = s.timeout && sh.includes(s.timeout.match);
    if (timedOut && !s.timeout.applied) return {exit_code: null, timed_out: true, stdout: ''};
    if (sh.includes('systemctl mask --runtime --no-reload $u')) Object.keys(s.units).forEach(u => { if (!s.refuseMask.includes(u)) s.units[u].load = 'masked'; });
    if (sh.includes('systemctl unmask --runtime')) Object.keys(s.units).forEach(u => { s.units[u].load = 'loaded'; });
    let m;
    const re = /vconftool set -f -t int (\S+) (-?\d+)/g;
    while (!s.refuseVconf && (m = re.exec(sh))) { if (m[1] === L.AUTOUPDATE) s.autoupdate = Number(m[2]); else s.fws = Number(m[2]); }
    return timedOut ? {exit_code: null, timed_out: true, stdout: ''} : {exit_code: 0, stdout: ''};
  };
  return {s, execute};
}
function store() {
  let file = null;
  return {get: () => file && JSON.parse(file), readFileSync() { if (file === null) throw Error('absent'); return file; }, writeFileSync(p, t) { this.tmp = t; }, renameSync() { file = this.tmp; }};
}
const noSleep = () => Promise.resolve();

(async () => {
  // Scripts: runtime masks only (a plain mask would be written to /etc), installers never stopped, USB recovery untouched.
  const lock = L.maskScript();
  assert.ok(!/systemctl mask (?!--runtime)/.test(lock), 'never a persistent mask');
  assert.ok(lock.includes('systemctl mask --runtime --no-reload $u'), 'one mask per unit, without its own reload');
  assert.equal(lock.match(/daemon-reload/g).length, 1, 'a single reload per pass');
  const stopped = /for u in ([^;]+); do systemctl stop/.exec(lock)[1].split(' ');
  L.NOSTOP.forEach(u => assert.ok(!stopped.includes(u), u + ' is masked, never stopped'));
  assert.ok(!lock.includes('swu-standalone') && !L.UNITS.some(u => u.includes('standalone')), 'USB recovery path left alone');
  assert.ok(!/systemctl (start|restart)/.test(lock), 'the lock starts nothing');
  assert.ok(L.unmaskScript().includes('systemctl unmask --runtime') && L.BOOT_STARTED.every(u => L.unmaskScript().includes(u)));
  assert.ok(L.BOOT_STARTED.includes('swu-auto-upgrade.path'), 'the path trigger the boot starts comes back too');
  assert.equal(L.AUTOUPDATE, require('../service/quick-wins.js').AUTOUPDATE, 'one key for lock and quick win');

  // On: everything masked, Auto update 0, the previous value saved; the EMP key is not written where it does not exist.
  let t = tv(), st = store(), l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  assert.equal((await l.read()).status, 'off');
  let r = await l.set(true);
  assert.equal(r.status, 'on'); assert.equal(r.changed, true);
  assert.equal(t.s.autoupdate, 0); assert.equal(t.s.fws, null);
  assert.equal(st.get().on, true); assert.equal(st.get().autoupdatePrevious, 1); assert.equal(st.get().boot, t.s.boot);
  assert.equal(r.units, 15, 'units this firmware lacks do not count');
  assert.equal((await l.set(true)).changed, false, 'already on');

  // A boot clears the runtime masks: boot() puts them back (twice, 30 s apart) and records the new boot id; no vconf write.
  t.s.boot = '99999999-2222-3333-4444-555555555555';
  Object.keys(t.s.units).forEach(u => { t.s.units[u].load = 'loaded'; });
  const n = t.s.scripts.length;
  r = await l.boot();
  assert.equal(r.applied, true); assert.equal(r.status, 'on');
  assert.equal(st.get().boot, t.s.boot);
  const bootScripts = t.s.scripts.slice(n);
  assert.equal(bootScripts.filter(x => x.includes('mask --runtime')).length, 2, 'applied now and once more');
  assert.ok(bootScripts.every(x => !x.includes('vconftool set')), 'no vconf write at boot');
  r = await l.boot();
  assert.deepEqual(r, {skip: 'already applied this boot'});

  // Off: unmask, start what the boot starts, write back the saved Auto update value, then forget it.
  r = await l.set(false);
  assert.equal(r.status, 'off'); assert.equal(t.s.autoupdate, 1);
  assert.equal(st.get().on, false); assert.equal(st.get().autoupdatePrevious, null);
  assert.equal(await l.boot(), null, 'off: nothing at boot');

  // An owner who had Auto update off keeps it off after the lock ends (0 is never saved as the previous value).
  t = tv({autoupdate: 0}); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  await l.set(true); await l.set(false);
  assert.equal(t.s.autoupdate, 0);
  assert.ok(t.s.scripts.every(x => !/vconftool set -f -t int \S+ 1/.test(x)));

  // A unit the TV will not mask: the change fails and is not remembered, so no boot applies it later.
  t = tv({refuseMask: ['was-background-update.service']}); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  await assert.rejects(l.set(true), /did not keep the lock \(14 of 15/);
  assert.equal(st.get().on, false); assert.equal(st.get().boot, null);
  assert.equal(st.get().autoupdatePrevious, 1, 'the value to put back is saved before anything is written');
  assert.equal(await l.boot(), null, 'a failed lock is not applied at the next boot');
  assert.equal(l.busy, false);
  // ... and switching off afterwards still writes the saved Auto update value back.
  t.s.refuseMask = [];
  r = await l.set(false);
  assert.equal(r.status, 'off'); assert.equal(t.s.autoupdate, 1); assert.equal(st.get().autoupdatePrevious, null);

  // A call that times out although the TV did everything: the readback decides, the lock counts as on.
  t = tv({timeout: {match: 'mask --runtime', applied: true}}); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  r = await l.set(true);
  assert.equal(r.status, 'on'); assert.equal(st.get().on, true); assert.equal(st.get().boot, t.s.boot);

  // An undo the TV refuses: the masks stay, so the lock stays chosen (and is applied again at boot).
  t.s.timeout = {match: 'unmask', applied: false};
  await assert.rejects(l.set(false), /refused/);
  assert.equal(st.get().on, true); assert.equal(st.get().autoupdatePrevious, 1);

  // Masks gone but Auto update not written back (the TV rebooted, vconf refused, ...): off is saved, the value is kept,
  // and switching off again is not answered with "already off" but writes it back.
  t.s.timeout = null; t.s.refuseVconf = true;
  await assert.rejects(l.set(false), /Auto update was not set back/);
  assert.equal(st.get().on, false); assert.equal(st.get().autoupdatePrevious, 1); assert.equal(t.s.autoupdate, 0);
  t.s.refuseVconf = false;
  r = await l.set(false);
  assert.equal(r.changed, true); assert.equal(t.s.autoupdate, 1); assert.equal(st.get().autoupdatePrevious, null);
  assert.equal((await l.set(false)).changed, false, 'now really off');

  // After a boot: a busy TV fails the first tries; bootRetry keeps going until the lock is confirmed on.
  t = tv(); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  await l.set(true);
  t.s.boot = '99999999-2222-3333-4444-555555555555';
  Object.keys(t.s.units).forEach(u => { t.s.units[u].load = 'loaded'; });
  t.s.failReads = 2;   // the first two reads fail: agent queue full
  let waits = 0;
  l.sleep = () => { waits++; return Promise.resolve(); };
  r = await l.bootRetry(() => true);
  assert.equal(r.status, 'on'); assert.equal(st.get().boot, t.s.boot);
  assert.ok(waits >= 2, 'waited between tries');
  // A unit that never masks: bounded number of tries, then it gives up.
  t.s.boot = 'aaaaaaaa-2222-3333-4444-555555555555'; t.s.refuseMask = ['swu-service.service'];
  Object.keys(t.s.units).forEach(u => { t.s.units[u].load = 'loaded'; });
  const before = t.s.scripts.filter(x => x.includes('mask --runtime')).length;
  r = await l.bootRetry(() => true, 3);
  assert.equal(r.status, 'partial');
  assert.equal(t.s.scripts.filter(x => x.includes('mask --runtime')).length - before, 6, '3 tries of 2 passes');
  // Not chosen: one look, nothing applied.
  t = tv(); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  assert.equal(await l.bootRetry(() => true), null);
  assert.equal(t.s.scripts.length, 0);
  // The agent is not up yet: waits for it before the first try.
  let up = 0; t = tv(); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  await l.set(true); t.s.boot = 'bbbbbbbb-2222-3333-4444-555555555555';
  Object.keys(t.s.units).forEach(u => { t.s.units[u].load = 'loaded'; });
  r = await l.bootRetry(() => ++up > 3);
  assert.equal(r.status, 'on'); assert.equal(up, 4);
  await assert.rejects(l.set('yes'), /Invalid/);
  console.log('update-lock: ok');
})().catch(e => { console.error(e); process.exit(1); });
