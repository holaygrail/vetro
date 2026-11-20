'use strict';
const assert = require('assert').strict;
require('../service/compat.js').install();
const L = require('../service/update-lock.js');

// A small TV: Auto update, the units with load/active state, the boot id. Scripts are read, not run.
function tv(start) {
  const s = Object.assign({autoupdate: 1, fws: null, boot: '11111111-2222-3333-4444-555555555555', refuseMask: [], scripts: []}, start);
  s.units = {};
  L.UNITS.forEach(u => { s.units[u] = {load: 'loaded', active: /timer|path/.test(u) || u === 'swu-auto-upgrade.service' ? 'active' : 'inactive'}; });
  delete s.units['bootmode-system-update.service'];   // a unit this firmware lacks
  const execute = async cmd => {
    const sh = Buffer.from(cmd.split(' ')[1], 'base64').toString();
    s.scripts.push(sh);
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
    if (sh.includes('systemctl mask --runtime $u')) Object.keys(s.units).forEach(u => { if (!s.refuseMask.includes(u)) s.units[u].load = 'masked'; });
    if (sh.includes('systemctl unmask --runtime')) Object.keys(s.units).forEach(u => { s.units[u].load = 'loaded'; });
    let m;
    const re = /vconftool set -f -t int (\S+) (-?\d+)/g;
    while ((m = re.exec(sh))) { if (m[1] === L.AUTOUPDATE) s.autoupdate = Number(m[2]); else s.fws = Number(m[2]); }
    return {exit_code: 0, stdout: ''};
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
  const lock = L.maskScript(true);
  assert.ok(!/systemctl mask (?!--runtime)/.test(lock), 'never a persistent mask');
  const stopped = /for u in ([^;]+); do systemctl stop/.exec(lock)[1].split(' ');
  L.NOSTOP.forEach(u => assert.ok(!stopped.includes(u), u + ' is masked, never stopped'));
  assert.ok(!lock.includes('swu-standalone') && !L.UNITS.some(u => u.includes('standalone')), 'USB recovery path left alone');
  assert.ok(!/systemctl (start|restart)/.test(lock), 'the lock starts nothing');
  assert.ok(L.unmaskScript().includes('systemctl unmask --runtime') && L.BOOT_STARTED.every(u => L.unmaskScript().includes(u)));

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

  // A unit the TV will not mask: the change fails, and the boot is not recorded as locked.
  t = tv({refuseMask: ['was-background-update.service']}); st = store(); l = new L.Lock(t.execute, {fs: st, sleep: noSleep});
  await assert.rejects(l.set(true), /did not keep the lock \(14 of 15/);
  assert.equal(st.get().boot, null);
  assert.equal(l.busy, false);
  await assert.rejects(l.set('yes'), /Invalid/);
  console.log('update-lock: ok');
})().catch(e => { console.error(e); process.exit(1); });
