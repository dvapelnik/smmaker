var express = require('express');
var fs = require('fs');

winston = require('winston');

module.exports = function (options) {
  options = options || {
    logger: new (winston.Logger)({
      transports: [
        new (winston.transports.Console)()
      ]
    })
  };

  var logger = options.logger;

  var app = new express();

  app.use('/bower', express.static('web/bower'));
  app.use('/js', express.static('web/js'));
  app.use('/sitemaps', express.static('web/sitemaps'));

  app.get(/^\/(index.html)?$/, function (req, res) {
    logger.verbose('Responded: /');
    fs.createReadStream('web/index.html').pipe(res);
  });

  return app;
};