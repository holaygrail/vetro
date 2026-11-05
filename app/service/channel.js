'use strict';

// Direct tuning for remap rules. tv-viewer tunes a service when it is launched with the bundle
// "svcid <service id>" (CAppControlHandleProcessor::m_ProcessSvcid; tested on an S90C, Tizen 9,
// from live TV and from Home). Service IDs change with every channel scan, so the ID of the
// channel number is read from the channel database at each press, read-only.

var DB_DIR = '/mnt/systemrw/tvs-chms/data';
var DBS = ['dvbc', 'dvbt', 'sat'];   // cable, terrestrial, satellite; the first one with the number wins
var MAX = 9999;

function valid(n) { return Number.isInteger(n) && n >= 1 && n <= MAX; }

function tuneCommand(number) {
    if (!valid(number)) return null;
    var query = 'select srvId from SRV where major=' + number + ' and hidden=0 order by minor limit 1';
    return 'id=; for f in ' + DBS.join(' ') + '; do p=' + DB_DIR + '/$f; [ -f "$p" ] || continue; ' +
        'id=$(sqlite3 -readonly "$p" "' + query + '" 2>/dev/null); [ -n "$id" ] && break; done; ' +
        '[ -n "$id" ] || { echo "channel ' + number + ' not found" >&2; exit 1; }; ' +
        '/usr/bin/launch_app org.tizen.tv-viewer svcid "$id"';
}

module.exports = { MAX: MAX, valid: valid, tuneCommand: tuneCommand };
