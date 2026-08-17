'use strict';

// Serialize destructive ledger operations with normal scans. A pricing refresh
// can arrive while the startup backfill is still reading thousands of files;
// clearing live state in that window loses the prefix already processed.  Each
// meter uses one queue, while repeated timer scans share a single pending job.
function createMeterQueue() {
  let tail = Promise.resolve();
  let pendingScan = null;

  function exclusive(work) {
    const job = tail.catch(() => {}).then(work);
    tail = job;
    return job;
  }

  function scan(work) {
    if (pendingScan) return pendingScan;
    const job = exclusive(work);
    const wrapped = job.finally(() => {
      if (pendingScan === wrapped) pendingScan = null;
    });
    pendingScan = wrapped;
    return wrapped;
  }

  return { scan, exclusive };
}

module.exports = { createMeterQueue };
