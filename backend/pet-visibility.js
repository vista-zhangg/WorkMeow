'use strict';

// Visibility belongs to the desktop window, independently of its cat/capsule
// renderer. Keep the reasons separate so ending fullscreen cannot undo a hide.
function createPetVisibilityController({ now = Date.now, onChange = () => {}, autoHideFullscreen = true } = {}) {
  let manualHidden = false;
  let quietUntil = 0;
  let fullscreen = false;
  let fullscreenOverride = false;
  let automatic = autoHideFullscreen !== false;
  let lastPublished = '';

  function expireQuiet() {
    if (quietUntil && now() >= quietUntil) quietUntil = 0;
  }

  function snapshot() {
    expireQuiet();
    return {
      visible: !manualHidden && !quietUntil && !(automatic && fullscreen && !fullscreenOverride),
      manualHidden,
      quietUntil,
      fullscreen,
      autoHideFullscreen: automatic,
      fullscreenOverride,
    };
  }

  function publish() {
    const value = snapshot();
    const key = JSON.stringify(value);
    if (key !== lastPublished) {
      lastPublished = key;
      onChange(value);
    }
    return value;
  }

  // Reading a snapshot must not consume the first change notification.
  lastPublished = JSON.stringify(snapshot());

  return {
    snapshot,
    tick: publish,
    hide() {
      manualHidden = true;
      quietUntil = 0;
      fullscreenOverride = false;
      return publish();
    },
    show() {
      manualHidden = false;
      quietUntil = 0;
      fullscreenOverride = fullscreen;
      return publish();
    },
    snooze(minutes = 30) {
      const duration = minutes;
      if (!Number.isInteger(duration) || duration < 1 || duration > 1440) return snapshot();
      // A timed hide replaces a previous manual hide by explicit user choice.
      manualHidden = false;
      quietUntil = now() + duration * 60 * 1000;
      fullscreenOverride = false;
      return publish();
    },
    setFullscreen(value) {
      fullscreen = value === true;
      if (!fullscreen) fullscreenOverride = false;
      return publish();
    },
    setAutoHideFullscreen(value) {
      automatic = value !== false;
      return publish();
    },
  };
}

module.exports = { createPetVisibilityController };
