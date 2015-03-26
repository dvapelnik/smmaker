#!/usr/bin/env node

var ws = require('nodejs-websocket');
var validator = require('validator');
var smMaker = require('./SmMaker');

var server = ws.createServer(function (conn) {
  conn.on('text', function (message) {
    var messageData = JSON.parse(message);

    smMaker.emit(messageData.action, {
      connection: conn,
      data: messageData.data
    });
  });

  conn.on('close', function (code, reason) {
    console.log('Disconnected');
  });
}).listen(3000);

server.on('connection', function () {
  console.log('Connected');
});