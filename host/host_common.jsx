/*
 * WatchHouse – helpers shared by the Premiere Pro and After Effects scripts.
 * ExtendScript is ES3: no JSON object, no Array.indexOf.
 */

function ow_str(s) {
    return '"' + String(s)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/[\u0000-\u001f\u2028\u2029]/g, function (c) {
            return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
}

function ow_stringify(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'string') return ow_str(v);
    if (v instanceof Array) {
        var a = [];
        for (var i = 0; i < v.length; i++) a.push(ow_stringify(v[i]));
        return '[' + a.join(',') + ']';
    }
    var parts = [];
    for (var k in v) {
        if (v.hasOwnProperty(k)) parts.push(ow_str(k) + ':' + ow_stringify(v[k]));
    }
    return '{' + parts.join(',') + '}';
}

function ow_parse(s) {
    return eval('(' + s + ')');
}

function ow_err(e) {
    return ow_stringify({ error: String(e && e.message ? e.message : e), line: e && e.line ? e.line : 0 });
}

function ow_norm(p) {
    return String(p || '').replace(/\\/g, '/').toLowerCase();
}
