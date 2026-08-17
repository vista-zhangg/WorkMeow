'use strict';

// Read-only compatibility for one upgrade boundary. New traffic always uses
// WorkMeow headers; accepting the previous identity lets an already-installed
// hook survive until the startup installer rewrites it.
module.exports = Object.freeze([
  Object.freeze({
    serverId: 'octopus',
    serverHeader: 'x-octopus-server',
    tokenHeader: 'x-octopus-token',
  }),
]);
