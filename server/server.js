#!/usr/bin/env node

var winston = require('winston');
var logger = new (winston.Logger)({
  transports: [
    //new (winston.transports.Console)({
    //  name: 'console-verbose',
    //  level: 'verbose',
    //  colorize: true
    //}),
    //new (winston.transports.Console)({
    //  name: 'console-info',
    //  level: 'info',
    //  colorize: true,
    //  enabled: false
    //}),
    new (winston.transports.Console)({
      name: 'console-debug',
      level: 'debug',
      colorize: true
    }),
    //new (winston.transports.Console)({
    //  name: 'console-warn',
    //  level: 'warn',
    //  colorize: true
    //}),
    new (winston.transports.Console)({
      name: 'console-error',
      level: 'error',
      colorize: true
    })
  ]
});

var config  = require('./config');

var wsServer = require('./wsServer')({
  logger: logger,
  config: config
});

var httpExpressServer = require('./httpExpressServer')({
  logger: logger
});

wsServer.listen(3000, function () {
  logger.verbose('WebSocket server started');
});

httpExpressServer.listen(8080, function () {
  logger.verbose('Express server started on ', 8080, ' port');
});
