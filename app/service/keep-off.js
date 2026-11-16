'use strict';
// Keep off what Samsung's background app updates switch back on.
//
// A disabled app (pkgmgr app_disable) and a boot switch file (ConditionPathExists=!/opt/usr/share/systemd/system/<x>)
// are both state of the installed package. A package update resets them: on the S90C the pisa-service update of
// 2026-11-12 enabled pisa-service, adagent-service and pisa-control-service again and deleted the pisa-service flag
// two seconds after the install, so Samsung's ad agent ran again after the next boot.
//
// This module remembers what is off (snapshot file) and puts back only what an update undid:
// - an app that was disabled, is enabled now, and whose package was installed after the snapshot;
// - a flag file that existed, is gone now, and whose directory changed within FLAG_WINDOW seconds of a package
//   install made after the snapshot.
// Anything switched on another way (Vetro, pkgcmd -A, a restore script) had no install behind it: it is accepted
// and forgotten. Anything newly switched off is added to the snapshot on the next pass. Nothing is ever started.
var fs = require('fs');
var debloat = require('./debloat.js');

var FILE = '/opt/usr/home/owner/share/vetro-keep-off.json';
var DB = '/opt/dbspace/.pkgmgr_parser.db';
var FLAG_DIR = '/opt/usr/share/systemd/system';
var MIN_CLOCK = 1767225600;   // 2026-01-01: before the clock is set the TV can read 1970, which would make every install look new
var FLAG_WINDOW = 120;        // seconds between a package install and the flag directory change it caused
var LOG_KEEP = 20;
var ID = /^[A-Za-z0-9_.-]+$/;

function readCommand() {
    return 'echo __NOW__; date +%s; echo __DIR__; stat -c %Y ' + FLAG_DIR + '; echo __FLAGS__; ls -1 ' + FLAG_DIR +
        '; echo __APPS__; sqlite3 -readonly -separator "|" ' + DB +
        ' "SELECT a.app_id,a.package,a.app_disable,p.installed_time FROM package_app_info a JOIN package_info p ON a.package=p.package;"';
}

// -> {now, dirMtime, flags: [name], apps: {app_id: {pkg, disabled, installed}}}
function parse(out) {
    var cur = {now: 0, dirMtime: 0, flags: [], apps: {}}, part = null;
    String(out || '').split('\n').forEach(function (raw) {
        var line = raw.trim();
        if (/^__(NOW|DIR|FLAGS|APPS)__$/.test(line)) { part = line; return; }
        if (!line) return;
        if (part === '__NOW__') cur.now = Number(line) || 0;
        else if (part === '__DIR__') cur.dirMtime = Number(line) || 0;
        else if (part === '__FLAGS__') { if (ID.test(line)) cur.flags.push(line); }
        else if (part === '__APPS__') {
            var f = line.split('|');
            if (f.length < 4 || !ID.test(f[0])) return;
            cur.apps[f[0]] = {pkg: f[1], disabled: f[2] === 'true', installed: Number(f[3]) || 0};
        }
    });
    return cur;
}

function disabledIds(cur) {
    return Object.keys(cur.apps).filter(function (id) { return cur.apps[id].disabled; }).sort();
}

// saved: {at, apps, flags} or null. -> {skip} | {reapply: {apps, flags}, forgot: {apps, flags}, next}
function decide(saved, cur) {
    if (!(cur.now >= MIN_CLOCK)) return {skip: 'TV clock not set yet'};
    if (!Object.keys(cur.apps).length) return {skip: 'package list unreadable'};
    var off = disabledIds(cur);
    if (!saved || !(saved.at >= MIN_CLOCK) || !Array.isArray(saved.apps) || !Array.isArray(saved.flags)) {
        return {seeded: true, reapply: {apps: [], flags: []}, forgot: {apps: [], flags: []}, next: {at: cur.now, apps: off, flags: cur.flags.slice().sort()}};
    }
    var since = saved.at, re = {apps: [], flags: []}, forgot = {apps: [], flags: []};
    saved.apps.forEach(function (id) {
        var a = cur.apps[id];
        if (!a) { forgot.apps.push(id); return; }            // package removed
        if (a.disabled) return;
        if (a.installed > since && !debloat.isProtected(id) && !debloat.isProtected(a.pkg)) re.apps.push(id);
        else forgot.apps.push(id);                           // switched on without an update: the user's choice
    });
    var installs = Object.keys(cur.apps).map(function (id) { return cur.apps[id].installed; })
        .filter(function (t) { return t > since; });
    var byInstall = cur.dirMtime > since && installs.some(function (t) { return Math.abs(cur.dirMtime - t) <= FLAG_WINDOW; });
    saved.flags.forEach(function (f) {
        if (cur.flags.indexOf(f) !== -1) return;
        if (byInstall && ID.test(f)) re.flags.push(f); else forgot.flags.push(f);
    });
    var apps = off.concat(re.apps).sort(), flags = cur.flags.concat(re.flags).sort();
    return {reapply: re, forgot: forgot, next: {at: Math.max(cur.now, since), apps: apps, flags: flags}};
}

// Flags first, so a unit that restarts on failure meets its switch; then stop the units that switch guards
// (without waiting: a slow stop must not hold the agent); then disable the apps (pkgmgr also ends running ones).
function applyScript(re) {
    var lines = [];
    re.flags.forEach(function (f) {
        var p = FLAG_DIR + '/' + f;
        lines.push('touch ' + p + ' && chmod 666 ' + p + ' && (chsmack -a User ' + p + ' 2>/dev/null; true)');
        lines.push('for u in $(grep -l \'ConditionPathExists=!' + p + '\' /usr/lib/systemd/system/*.service 2>/dev/null); do ' +
            'n=${u##*/}; systemctl -q is-active "$n" && systemctl --no-block stop "$n"; done; true');
    });
    re.apps.forEach(function (id) {
        lines.push('pkgcmd -D -t app -n ' + id + ' --global >/dev/null 2>&1');
        lines.push('[ "$(sqlite3 -readonly ' + DB + ' "SELECT app_disable FROM package_app_info WHERE app_id=\'' + id + '\';")" = true ] || { echo "not disabled: ' + id + '"; exit 1; }');
    });
    return lines.join('\n');
}

function wrap(s) { return 'echo ' + Buffer.from(s).toString('base64') + ' | base64 -d | sh'; }

function Keeper(execute, storage) { this.execute = execute; this.fs = storage || fs; this.busy = false; this.last = null; }
Keeper.prototype.load = function () {
    try { return JSON.parse(this.fs.readFileSync(FILE, 'utf8')); } catch (e) { return null; }
};
Keeper.prototype.save = function (state) {
    var tmp = FILE + '.tmp';
    this.fs.writeFileSync(tmp, JSON.stringify(state) + '\n', {mode: 384});
    this.fs.renameSync(tmp, FILE);
};
Keeper.prototype.status = function () {
    var s = this.load() || {};
    return {last: this.last, snapshotAt: s.at || null, apps: s.apps || [], flags: s.flags || [], log: s.log || []};
};
// One pass. A failed apply keeps the old snapshot, so the next pass tries again.
Keeper.prototype.run = function () {
    var self = this;
    if (this.busy) return Promise.resolve({skip: 'busy'});
    this.busy = true;
    return this.execute(readCommand(), 20000).then(function (r) {
        if (r.exit_code || r.timed_out) throw Error(r.stderr || 'state unreadable');
        var saved = self.load(), cur = parse(r.stdout), d = decide(saved, cur);
        if (d.skip) return d;
        var n = d.reapply.apps.length + d.reapply.flags.length;
        var done = n ? self.execute(wrap(applyScript(d.reapply)), 120000).then(function (a) {
            if (a.exit_code || a.timed_out) throw Error((a.stdout || '') + (a.stderr || '') || 'apply failed');
        }) : Promise.resolve();
        return done.then(function () {
            var log = (saved && Array.isArray(saved.log) ? saved.log : []);
            if (n || d.forgot.apps.length || d.forgot.flags.length) {
                log = log.concat([{at: cur.now, reapplied: d.reapply, forgot: d.forgot}]).slice(-LOG_KEEP);
            }
            self.save({at: d.next.at, apps: d.next.apps, flags: d.next.flags, log: log});
            return d;
        });
    }).then(function (d) {
        self.last = {at: Date.now(), result: d.skip ? {skip: d.skip} : {seeded: !!d.seeded, reapplied: d.reapply, forgot: d.forgot}};
        return self.last.result;
    }, function (e) {
        self.last = {at: Date.now(), error: e.message};
        throw e;
    }).finally(function () { self.busy = false; });
};

module.exports = {Keeper: Keeper, parse: parse, decide: decide, applyScript: applyScript, readCommand: readCommand,
    FILE: FILE, FLAG_DIR: FLAG_DIR, MIN_CLOCK: MIN_CLOCK, FLAG_WINDOW: FLAG_WINDOW};
