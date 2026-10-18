/* WatchHouse – hidden background extension. Runs the sync engine. */
(function () {
  'use strict';
  var engine = OW.require(OW.path.join(OW.extPath, 'lib', 'engine.js')).createEngine({
    core: OW.core,
    evalScript: OW.evalScript,
    t: OW.t,
    onLog: function (line) { OW.send(OW.EVT_LOG, line); },
    onStatus: function (st) { OW.send(OW.EVT_STATUS, st); }
  });

  window.OW.engine = engine; // for debugging in the DevTools console

  OW.on(OW.EVT_CMD, function (cmd) {
    if (cmd.cmd === 'ping') {
      OW.send(OW.EVT_PONG, { from: 'background', log: engine.logLines(), status: engine.status() });
      return;
    }
    engine.command(cmd);
  });

  // Keep the extension alive when the panel is closed.
  try { OW.cs.setPersistent && OW.cs.setPersistent(true); } catch (e) {}
  try {
    var ev = new CSEvent('com.adobe.PhotoshopPersistent', 'APPLICATION');
    ev.extensionId = OW.cs.getExtensionID();
    OW.cs.dispatchEvent(ev);
  } catch (e) {}

  OW.loadHost().then(function () {
    engine.start();
    OW.send(OW.EVT_PONG, { from: 'background', log: engine.logLines(), status: engine.status() });
  });
})();
