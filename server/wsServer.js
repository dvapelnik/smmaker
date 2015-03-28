var ws = require('nodejs-websocket');

module.exports = function (options) {
  options = options || {
    logger: new (winston.Logger)({
      transports: [
        new (winston.transports.Console)()
      ]
    })
  };

  var logger = options.logger;

  var SmMaker = require('./SmMaker')({
    logger: options.logger
  });

  return ws.createServer(function (conn) {
    conn.smMaker = new SmMaker(conn);

    conn.on('text', function (message) {
      var messageData = JSON.parse(message);

      conn.smMaker.emit(messageData.action, {
        data: messageData.data
      });
    }).on('close', function (code, reason) {
      logger.info('<<< Disconnected');

      this.smMaker.emit('interrupt');

      logger.verbose('[socket-disconnected] event emitted');
      this.smMaker.emit('socket-disconnected');
    }).on('error', function (error) {
      logger.error(error);
    });
  }).on('error', function (error) {
    logger.error(error);
  }).on('connection', function (conn) {
    logger.info('>>> Connected');
  });
};



