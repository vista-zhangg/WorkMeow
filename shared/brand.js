'use strict';

// Canonical WorkMeow identity. Runtime modules import these values instead of
// repeating product, protocol and storage names in several independent places.
module.exports = Object.freeze({
  name: 'WorkMeow',
  displayName: '打工喵',
  appId: 'io.github.vista-zhangg.workmeow',
  serverId: 'workmeow',
  serverHeader: 'x-workmeow-server',
  tokenHeader: 'x-workmeow-token',
  stateDirName: '.workmeow',
});
