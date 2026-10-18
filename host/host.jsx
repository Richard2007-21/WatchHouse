/*
 * WatchHouse – loader. Loads the shared helpers and the script for the
 * current application (Premiere Pro or After Effects).
 *
 * It must never throw: an error in the manifest's ScriptPath leaves the
 * ExtendScript engine of the extension unusable ("EvalScript error." for
 * every later call). The panel loads the scripts again by absolute path
 * (client/common.js → loadHost) if this loader could not.
 */
(function () {
    try {
        var here = $.fileName ? new File($.fileName) : null;
        if (!here || !here.exists) return;
        var dir = here.parent.fsName;
        var isAE = BridgeTalk.appName === 'aftereffects';
        $.evalFile(new File(dir + '/host_common.jsx'));
        $.evalFile(new File(dir + (isAE ? '/host_aeft.jsx' : '/host_ppro.jsx')));
    } catch (e) {
        // Leave it to loadHost() in client/common.js.
    }
})();
