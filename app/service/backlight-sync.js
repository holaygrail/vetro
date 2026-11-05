'use strict';
// Panel brightness for MQTT, kept in sync with the TV by events instead of polling.
//
// Measured on the S90C (Tizen 9, 2026-11-05):
// - The backlight is stored per picture mode. Switching the mode changes GetBacklight(0) at once but emits only
//   PictureModeChanged, no BacklightChanged; SetBacklight and the TV menu emit BacklightChanged.
// - `gdbus monitor --dest org.tizen.tv.avoc` subscribes to avocd's signals only (busctl monitor would see the
//   whole bus) and prints one line per signal.
// A root helper runs that monitor and streams its lines to a loopback socket of this service. A line is only a
// hint: the value itself is always read through the agent, so the socket needs no authentication; hints are
// debounced and rate limited. A slow poll covers a helper that died or a missed signal.

var net = require('net'), crypto = require('crypto');

var HINT = /\.(BacklightChanged|PictureModeChanged)\b/;
var PID_FILE = '/tmp/vetro-avoc-monitor.pid';

function BacklightSync(o) {
    this.store = o.store;                 // tv-settings Store: readOne(id), writeLatest(id, value)
    this.execute = o.execute;             // agent command runner
    this.publish = o.publish;             // publish(value|null)
    this.event = o.event || function () {};
    this.debounceMs = o.debounceMs == null ? 200 : o.debounceMs;
    this.pollMs = o.pollMs || 60000;
    this.firstBackoff = o.backoffMs || 5000;
    this.timers = o.timers || {setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval};
    this.running = false; this.server = null; this.socket = null; this.poller = null; this.restartTimer = null;
    this.debounce = null; this.backoff = this.firstBackoff; this.hints = 0;
    this.busy = false; this.next = null; this.wanted = null; this.last = undefined; this.readAfterWrite = false;
}

// --- reads -------------------------------------------------------------------------------------------------
BacklightSync.prototype.show = function (value, force) {
    if (!force && value === this.last) return;
    this.last = value;
    try { this.publish(value); } catch (e) { /* MQTT down; the next connect republishes */ }
};
BacklightSync.prototype.refresh = function (force) {
    var self = this;
    if (this.busy) { this.readAfterWrite = true; return Promise.resolve(); }
    return this.store.readOne('backlight').then(function (v) { return v; }, function () { return null; })
        .then(function (v) { if (!self.busy) self.show(v, force); });
};
BacklightSync.prototype.hint = function () {
    var self = this;
    this.hints++;
    if (this.debounce) return;
    this.debounce = this.timers.setTimeout(function () { self.debounce = null; self.refresh(false); }, this.debounceMs);
};

// --- writes: echo at once, newest value wins, readback only when the TV ends elsewhere -----------------------
BacklightSync.prototype.request = function (payload) {
    var text = String(payload).trim(), value = /^\d{1,2}(\.0+)?$/.test(text) ? Math.round(+text) : NaN;
    if (!(value >= 0 && value <= 50)) { this.event('error', 'Panel brightness: invalid value'); return false; }
    this.wanted = value; this.show(value, true); this.next = value;
    if (!this.busy) { this.busy = true; this._write(); }
    return true;
};
BacklightSync.prototype._write = function () {
    var self = this, v = this.next; this.next = null;
    return this.store.writeLatest('backlight', v).then(function (d) {
        self.event('trigger', 'Panel brightness ' + d.previous + ' → ' + d.value + ' read back'); return d.value;
    }, function (e) {
        self.event('error', 'Panel brightness: ' + e.message);
        return self.store.readOne('backlight').catch(function () { return null; });
    }).then(function (actual) {
        if (self.next !== null) return self._write();
        self.busy = false;
        if (self.readAfterWrite) { self.readAfterWrite = false; return self.refresh(false); }
        if (actual !== self.wanted) self.show(actual, false); else self.last = actual;
    });
};

// --- signal helper -------------------------------------------------------------------------------------------
BacklightSync.prototype.helperCommand = function (port) {
    // Ends an older helper (by PID file, only if it is still a gdbus monitor), then connects to the loopback port
    // and replaces itself with the monitor, so the PID file names the gdbus process.
    var inner = 'exec 3<>/dev/tcp/127.0.0.1/' + port + ' || exit 1; echo $$ > ' + PID_FILE + '; ' +
        'exec gdbus monitor --system --dest org.tizen.tv.avoc --object-path /org/tizen/tv/avoc >&3 2>/dev/null';
    return 'old=$(cat ' + PID_FILE + ' 2>/dev/null); ' +
        'if [ -n "$old" ] && tr "\\0" " " < /proc/$old/cmdline 2>/dev/null | grep -q "gdbus monitor"; then kill $old; fi; ' +
        "nohup bash -c '" + inner + "' </dev/null >/dev/null 2>&1 &";
};
BacklightSync.prototype._launch = function () {
    var self = this;
    if (!this.running) return;
    var server = net.createServer(function (socket) {
        if (self.socket || server !== self.server) { socket.destroy(); return; }
        self.socket = socket; self.backoff = self.firstBackoff; var buffer = '';
        self.event('connected', 'Picture events: helper connected');
        self.refresh(true);
        socket.on('data', function (chunk) {
            buffer += chunk.toString('utf8');
            if (buffer.length > 65536) buffer = buffer.slice(-4096);
            var i; while ((i = buffer.indexOf('\n')) >= 0) { var line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (HINT.test(line)) self.hint(); }
        });
        socket.on('error', function () {});
        socket.on('close', function () {
            if (self.socket !== socket) return;
            self.socket = null; self.event('error', 'Picture events: helper ended; restarting');
            self._restart();
        });
    });
    this.server = server;
    server.on('error', function () { self._restart(); });
    server.listen(0, '127.0.0.1', function () {
        if (server !== self.server) return;
        self.execute(self.helperCommand(server.address().port), 5000).then(function (r) { if (r.exit_code || r.timed_out) throw Error('launch failed'); })
            .catch(function () { self.event('error', 'Picture events: helper launch failed'); self._restart(); });
        // No connection within 10 s: the helper could not start (missing gdbus, agent down).
        self.timers.setTimeout(function () { if (self.server === server && !self.socket) self._restart(); }, 10000);
    });
};
BacklightSync.prototype._close = function () {
    if (this.socket) { var s = this.socket; this.socket = null; s.destroy(); }
    if (this.server) { var srv = this.server; this.server = null; try { srv.close(); } catch (e) {} }
};
BacklightSync.prototype._restart = function () {
    var self = this;
    this._close();
    if (!this.running || this.restartTimer) return;
    this.restartTimer = this.timers.setTimeout(function () { self.restartTimer = null; self._launch(); }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 300000);
};

// --- lifecycle -----------------------------------------------------------------------------------------------
BacklightSync.prototype.start = function () {
    var self = this;
    if (this.running) return;
    this.running = true; this.backoff = this.firstBackoff; this.last = undefined;
    this.refresh(true);
    this.poller = this.timers.setInterval(function () { self.refresh(false); }, this.pollMs);
    this._launch();
};
BacklightSync.prototype.stop = function () {
    this.running = false;
    if (this.poller) this.timers.clearInterval(this.poller);
    if (this.restartTimer) this.timers.clearTimeout(this.restartTimer);
    if (this.debounce) this.timers.clearTimeout(this.debounce);
    this.poller = this.restartTimer = this.debounce = null;
    this._close();
    // The helper exits on its next write to the closed socket; ending it now keeps no stray monitor around.
    this.execute('old=$(cat ' + PID_FILE + ' 2>/dev/null); if [ -n "$old" ] && tr "\\0" " " < /proc/$old/cmdline 2>/dev/null | grep -q "gdbus monitor"; then kill $old; fi; rm -f ' + PID_FILE, 5000).catch(function () {});
};
BacklightSync.prototype.status = function () {
    return {running: this.running, helperConnected: !!this.socket, hints: this.hints, value: this.last === undefined ? null : this.last, writing: this.busy};
};

module.exports = {BacklightSync: BacklightSync, HINT: HINT};
