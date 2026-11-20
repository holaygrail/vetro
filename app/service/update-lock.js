'use strict';
// Block Samsung's firmware and software updates (port of upstream 0.7.0 df1e44a + 177ff06, "Block firmware and software
// updates", reworked as its own module for this 0.3.5-based fork).
//
// Why: upstream issue #223 (2026-11-20): Samsung force-pushed an sdbd update (fw 1722.0) to Tizen 6.5/7/8 TVs although Auto
// update was off, and root was gone. "Auto update" (db/menu/support/softwareupdate/autoupdate) only changes what the SWU
// daemons do with a downloaded image; the background loop and the app updater keep running. The app updater is also what
// switched Samsung's ad agent back on here on 2026-11-12 (see keep-off.js).
//
// What: every unit that can change the TV's software is masked with --runtime (the rootfs is read-only; a plain mask would
// be written to /etc and outlive Vetro), the stoppable ones are stopped first, Auto update is set to 0 and the download
// markers are removed. Runtime masks live in /run, so the lock is applied again after every boot, as soon as the root
// agent is up (before the SWU timer's OnActiveSec=120), and once more 30 s later. The installers are masked but never
// stopped (a stop in the middle of a write could break an install). swu-standalone (USB recovery) is left alone.
// A masked unit refuses every start at once: D-Bus activation fails immediately instead of waiting, and Restart= never fires.
// Off: unmask, start again what the boot sequence starts, and write back only values Vetro saved.
var fs = require('fs');
var wins = require('./quick-wins.js');   // the same Auto update key and shell wrapper as the quick win

var FILE = '/opt/usr/home/owner/share/vetro-update-lock.json';
var AUTOUPDATE = wins.AUTOUPDATE;
var FWSERVICE = 'db/fw-update-service/service_onoff';   // absent on the S90C (2220.4)
var UNITS = ['swu-auto-upgrade.timer', 'swu-auto-upgrade.path', 'swu-auto-upgrade.service',
    'swu-verifier-tv.timer', 'swu-verifier-tv.service', 'swu-core-tv.service', 'swu-service.service',
    'was-background-update.path', 'was-background-update.service', 'fw-update-service.path', 'fw-update-service.service',
    'appbinary-manager.service', 'vdsystem-update-manager.timer', 'vdsystem-update-manager.service',
    'com.samsung.tv.preview-updater.service', 'bootmode-system-update.service'];
var NOSTOP = ['swu-core-tv.service', 'swu-service.service', 'bootmode-system-update.service'];
var MARKERS = ['/tmp/fw_update_ready', '/tmp/.fw_download_ready', '/run/user/5001/.swu-auto-upgrade-launch'];
// What the boot sequence starts (S90C before the lock: both swu-auto-upgrade triggers active); the rest comes back through
// D-Bus when needed.
var BOOT_STARTED = ['swu-auto-upgrade.timer', 'swu-auto-upgrade.path', 'swu-verifier-tv.service', 'was-background-update.path',
    'fw-update-service.path', 'vdsystem-update-manager.timer', 'appbinary-manager.service'];
var RETRY_MS = 30000;
var INT32 = /value = (-?\d+) \(Int32\)/;

var READ = [
    'echo "AU|$(vconftool get ' + AUTOUPDATE + ' 2>&1)"',
    'echo "FWS|$(vconftool get ' + FWSERVICE + ' 2>&1)"',
    'echo "BOOT|$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"',
    'systemctl show -p Id -p LoadState -p ActiveState ' + UNITS.join(' ') +
        ' 2>/dev/null | awk -F= \'/^Id=/{id=$2} /^LoadState=/{l=$2} /^ActiveState=/{print "LS|" id "|" l "|" $2}\''
].join('\n');

var wrap = wins.wrap;

function parse(out) {
    var r = {autoupdate: null, fwService: null, boot: null, units: {}};
    String(out || '').split('\n').forEach(function (line) {
        var f = line.trim().split('|');
        if (f[0] === 'AU') { var m = INT32.exec(f.slice(1).join('|')); if (m) r.autoupdate = Number(m[1]); }
        else if (f[0] === 'FWS') { var n = INT32.exec(f.slice(1).join('|')); if (n) r.fwService = Number(n[1]); }
        else if (f[0] === 'BOOT' && /^[0-9a-f-]{36}$/.test(f[1] || '')) r.boot = f[1];
        else if (f[0] === 'LS' && UNITS.indexOf(f[1]) !== -1) r.units[f[1]] = {load: f[2] || '', active: f[3] || ''};
    });
    return r;
}

// on: Auto update 0, the EMP switch 0 where it exists, every unit this firmware has masked. off: no unit masked.
function state(s) {
    var known = 0, masked = 0, running = 0;
    UNITS.forEach(function (u) {
        var x = s.units[u];
        if (!x || !x.load || x.load === 'not-found') return;
        known++;
        if (x.load === 'masked') masked++;
        if (x.active === 'active' || x.active === 'activating') running++;
    });
    var serviceOk = s.fwService === null || s.fwService === 0;
    var on = s.autoupdate === 0 && serviceOk && known > 0 && masked === known;
    return {status: s.autoupdate === null ? 'unknown' : on ? 'on' : masked === 0 ? 'off' : 'partial',
        autoupdate: s.autoupdate, masked: masked, units: known, running: running};
}

// One mask call per unit, so a unit the firmware refuses does not stop the others, but --no-reload and a single
// daemon-reload at the end: each implicit reload makes PID 1 re-read every unit (16 reloads per pass before).
function maskScript() {
    var stoppable = UNITS.filter(function (u) { return NOSTOP.indexOf(u) < 0; });
    return 'set +e\n' +
        'for u in ' + stoppable.join(' ') + '; do systemctl stop --no-block $u >/dev/null 2>&1; done\n' +
        'for u in ' + UNITS.join(' ') + '; do systemctl mask --runtime --no-reload $u >/dev/null 2>&1; done\n' +
        'systemctl daemon-reload >/dev/null 2>&1\n' +
        'rm -f ' + MARKERS.join(' ') + ' 2>/dev/null\n' +
        'true';
}
function unmaskScript() {
    return 'set +e\n' +
        'systemctl unmask --runtime ' + UNITS.join(' ') + ' >/dev/null 2>&1\n' +
        'systemctl reset-failed ' + UNITS.join(' ') + ' >/dev/null 2>&1\n' +
        'systemctl start --no-block ' + BOOT_STARTED.join(' ') + ' >/dev/null 2>&1\n' +
        'true';
}
function setKey(key, value) { return 'vconftool set -f -t int ' + key + ' ' + value + ' >/dev/null 2>&1'; }

function Lock(execute, options) {
    options = options || {};
    this.execute = execute;
    this.fs = options.fs || fs;
    this.sleep = options.sleep || function (ms) { return new Promise(function (r) { var t = setTimeout(r, ms); if (t.unref) t.unref(); }); };
    this.busy = false;
    this.bootBusy = false;
    this.lastBoot = null;
}
Lock.prototype.load = function () {
    try {
        var o = JSON.parse(this.fs.readFileSync(FILE, 'utf8'));
        return {on: o.on === true,
            autoupdatePrevious: Number.isInteger(o.autoupdatePrevious) && o.autoupdatePrevious > 0 ? o.autoupdatePrevious : null,
            fwServicePrevious: Number.isInteger(o.fwServicePrevious) && o.fwServicePrevious > 0 ? o.fwServicePrevious : null,
            boot: typeof o.boot === 'string' ? o.boot : null};
    } catch (e) { return {on: false, autoupdatePrevious: null, fwServicePrevious: null, boot: null}; }
};
Lock.prototype.save = function (patch) {
    var o = this.load();
    Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    var tmp = FILE + '.tmp';
    this.fs.writeFileSync(tmp, JSON.stringify(o) + '\n', {mode: 384});
    this.fs.renameSync(tmp, FILE);
    return o;
};
Lock.prototype.current = function () {
    return this.execute(wrap(READ), 15000).then(function (r) {
        if (r.exit_code || r.timed_out) throw Error(r.stderr || 'update state unreadable');
        return parse(r.stdout);
    });
};
Lock.prototype.read = function () {
    var self = this;
    return this.current().then(function (s) {
        var st = state(s), mine = self.load();
        st.chosen = mine.on;
        st.unitStates = s.units;
        st.lastBoot = self.lastBoot;
        return st;
    });
};
// One read, then the lock or the undo, then a readback. What counts is what the TV kept, so the readback also runs when
// the call itself failed or timed out. The choice is saved only once the TV confirmed it: a failed lock is not applied
// again at the next boot, and a failed undo keeps the lock chosen (the masks are still there).
Lock.prototype.set = function (on) {
    var self = this;
    if (typeof on !== 'boolean') return Promise.reject(Error('Invalid update lock state'));
    if (this.busy) return Promise.reject(Error('Update lock change already in progress'));
    this.busy = true;
    return this.current().then(function (before) {
        var st = state(before), mine = self.load();
        // Off counts as done only when no saved value is still waiting to be written back.
        var restorePending = !!(mine.autoupdatePrevious || mine.fwServicePrevious);
        if (on ? st.status === 'on' && mine.on : st.status === 'off' && !mine.on && !restorePending) return Object.assign(st, {changed: false});
        var script;
        if (on) {
            // The values to put back are saved before anything is written. A 0 found now may be an earlier lock's: the value
            // saved then is kept.
            self.save({autoupdatePrevious: before.autoupdate > 0 ? before.autoupdate : mine.autoupdatePrevious,
                fwServicePrevious: before.fwService > 0 ? before.fwService : mine.fwServicePrevious});
            script = maskScript() + '\n' + setKey(AUTOUPDATE, 0) + (before.fwService !== null ? '\n' + setKey(FWSERVICE, 0) : '');
        } else {
            script = unmaskScript() +
                (mine.autoupdatePrevious ? '\n' + setKey(AUTOUPDATE, mine.autoupdatePrevious) : '') +
                (mine.fwServicePrevious ? '\n' + setKey(FWSERVICE, mine.fwServicePrevious) : '');
        }
        return self.execute(wrap(script + '\ntrue'), 30000).then(function (r) { return !!r && !r.exit_code && !r.timed_out; },
            function () { return false; }).then(function (ran) {
            return self.current().then(function (after) {
                var st2 = state(after);
                var refused = 'The TV refused the update lock change';
                if (on) {
                    if (st2.status !== 'on') throw Error(ran ? 'The TV did not keep the lock (' + st2.masked + ' of ' + st2.units + ' update units masked)' : refused);
                    self.save({on: true, boot: after.boot});
                } else {
                    if (st2.masked > 0) throw Error(ran ? 'The TV did not end the lock (' + st2.masked + ' of ' + st2.units + ' still masked)' : refused);
                    self.save({on: false, boot: null});   // no mask left: never lock again at boot
                    var restored = (!mine.autoupdatePrevious || after.autoupdate === mine.autoupdatePrevious) &&
                        (!mine.fwServicePrevious || after.fwService === mine.fwServicePrevious);
                    // The saved values stay until the TV has them, so switching off again writes them back.
                    if (!restored) throw Error('The lock is off, but Auto update was not set back to its earlier value; switch the lock off again');
                    self.save({autoupdatePrevious: null, fwServicePrevious: null});
                }
                return Object.assign(st2, {changed: true});
            });
        });
    }).then(function (v) { self.busy = false; return v; }, function (e) { self.busy = false; throw e; });
};
// After a boot the runtime masks are gone: apply once now and once 30 s later (some units start late). No vconf write: that persisted.
Lock.prototype.boot = function () {
    var self = this;
    if (this.bootBusy) return Promise.resolve(null);
    var mine = this.load();
    if (!mine.on) return Promise.resolve(null);
    this.bootBusy = true;
    function chosen() { return !self.busy && self.load().on; }
    function pass() {
        if (!chosen()) return Promise.resolve(false);
        return self.execute(wrap(maskScript()), 30000).then(function (r) { return !!r && !r.exit_code && !r.timed_out; }, function () { return false; });
    }
    return this.current().then(function (s) {
        if (s.boot && mine.boot === s.boot && state(s).status === 'on') return {skip: 'already applied this boot'};
        return pass().then(function (first) {
            return self.sleep(RETRY_MS).then(pass).then(function (second) {
                return self.current().then(function (after) {
                    var st = state(after);
                    if ((first || second) && chosen() && st.status === 'on') self.save({boot: after.boot});
                    return {applied: first || second, status: st.status, masked: st.masked, units: st.units};
                });
            });
        });
    }).then(function (v) { self.bootBusy = false; self.lastBoot = {at: Date.now(), result: v}; return v; },
        function (e) { self.bootBusy = false; self.lastBoot = {at: Date.now(), error: e.message}; throw e; });
};

// The service's boot task: boot() as soon as the agent is up, and again every 30 s until the lock is confirmed on (or is no
// longer chosen), at most `tries` times. A single try could fail on a busy TV right after boot (agent queue full, read
// timeout), and the lock would then stay off for that whole boot.
Lock.prototype.bootRetry = function (connected, tries) {
    var self = this;
    tries = tries || 20;
    function attempt(n) {
        if (!connected()) return self.sleep(3000).then(function () { return attempt(n); });
        return self.boot().then(function (v) { return {done: !v || !!v.skip || v.status === 'on', v: v}; },
            function (e) { return {done: false, v: {error: e.message}}; }).then(function (r) {
            if (r.done || n >= tries) return r.v;
            return self.sleep(RETRY_MS).then(function () { return attempt(n + 1); });
        });
    }
    return attempt(1);
};

module.exports = {Lock: Lock, UNITS: UNITS, NOSTOP: NOSTOP, BOOT_STARTED: BOOT_STARTED, AUTOUPDATE: AUTOUPDATE, FILE: FILE,
    parse: parse, state: state, maskScript: maskScript, unmaskScript: unmaskScript, READ: READ};
