'use strict';

// The shared handler owns authentication and the cloud transaction boundary.
// Importing this entry does not start another HTTP listener.
module.exports = require('../server').handler;
