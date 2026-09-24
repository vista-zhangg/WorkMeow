'use strict';

// Read-only compatibility for one upgrade boundary. New traffic always uses
// AgentPaw headers; accepting the previous identity lets an already-installed
// hook survive until the startup installer rewrites it.
module.exports = Object.freeze([
  Object.freeze({
    serverId: 'workmeow',
    serverHeader: 'x-workmeow-server',
    tokenHeader: 'x-workmeow-token',
  }),
  Object.freeze({
    serverId: 'octopus',
    serverHeader: 'x-octopus-server',
    tokenHeader: 'x-octopus-token',
  }),
]);
