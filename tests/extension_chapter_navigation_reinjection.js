'use strict';
// The legacy message-receiver test was for Comic Bridge v1.4 and could hang
// after the v1.5 direct-execution upgrade. The persistent auto-connect test
// now covers chapter 1→2→3→4 with NO message receiver at any point.
require('./extension_persistent_autoconnect.js');
