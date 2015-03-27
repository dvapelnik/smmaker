#!/usr/bin/env node


var winston = require('winston');
var logger = new (winston.Logger)({
  transports: [
    //new (winston.transports.Console)({
    //  name: 'console-verbose',
    //  level: 'verbose',
    //  colorize: true
    //}),
    new (winston.transports.Console)({
      name: 'console-info',
      level: 'info',
      colorize: true,
      enabled: false
    }),
    new (winston.transports.Console)({
      name: 'console-debug',
      level: 'debug',
      colorize: true
    }),
    new (winston.transports.Console)({
      name: 'console-warn',
      level: 'warn',
      colorize: true
    }),
    new (winston.transports.Console)({
      name: 'console-error',
      level: 'error',
      colorize: true
    }),
    new (winston.transports.File)({
      name: 'file',
      filename: 'log/debug.log',
      level: 'debug,error,warn',
      json: true
    })
  ]
});

var ws = require('nodejs-websocket');
var SmMaker = require('./SmMaker')({
  logger: logger
});

var server = ws.createServer(function (conn) {
  conn.smMaker = new SmMaker(conn);

  conn.on('text', function (message) {
    var messageData = JSON.parse(message);

    conn.smMaker.emit(messageData.action, {
      data: messageData.data
    });
  });

  conn.on('close', function (code, reason) {
    logger.info('<<< Disconnected');
    logger.verbose('[socket-disconnected] event emitted');
    this.smMaker.emit('socket-disconnected');
  });

  conn.on('error', function (error) {
    logger.error(error);
  })
}).on('error', function (error) {
  logger.error(error);
}).on('connection', function (conn) {
  logger.info('>>> Connected');
}).listen(3000, function () {
  logger.verbose('WebSocket server started');
});

//server.on('connection', function (conn) {
//  logger.info('>>> Connected');
//});

