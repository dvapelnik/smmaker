var _ = require('underscore');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var Url = require('url');
var cheerio = require('cheerio');
var extend = require('extend');
var http = require('http');
var winston = require('winston');

module.exports = function (options) {
  options = options || {
    logger: new (winston.Logger)({
      transports: [
        new (winston.transports.Console)()
      ]
    })
  };

  var logger = options.logger;

  function SmMaker(socketConnection) {
    //region Properties
    this.targetSiteUri = undefined;
    this.maxDepth = undefined;
    this.countOfWorkers = undefined;
    this.changeFreq = undefined;
    this.evaluatePriority = undefined;
    this.maxCountOfUrl = undefined;

    this.workers = [];
    this.siteMapUris = [];
    this.uriPool = [];

    this.socketConnection = socketConnection;

    this.isBusy = false;
    //endregion

    this.sendMessage = function (message, type) {
      logger.verbose('Sending message', message, type);
      type = type || 'info';
      this.socketConnection.sendText(JSON.stringify({
        action: 'message',
        data: {
          message: message,
          type: type
        }
      }));
    };

    this.sendTransfer = function (transfer) {
      this.socketConnection.sendText(JSON.stringify({
        action: 'transfer',
        data: {
          data: transfer
        }
      }));
    };

    this.sendStatus = function (statusObject) {
      this.socketConnection.sendText(JSON.stringify({
        action: 'update-status',
        data: {
          data: statusObject
        }
      }));
    };

    this.addUriIntoPool = function (uri) {
      this.uriPool.push(uri);
      logger.verbose('[uriPoolAdded] event emitted');
      this.emit('uriPoolAdded', {uri: uri});
    };

    this.removeUriFromPool = function (uri) {
      if (this.uriPool.length == 0) return;

      var indexOfUri = this.uriPool.indexOf(uri);

      if (indexOfUri != -1) {
        this.uriPool.splice(indexOfUri, 1);

        this.emit('uriPoolRemoved', {uri: uri});
      }
    };

    this.getUriFromPool = function () {
      var filteredUriPool = _.filter(this.uriPool, function (uri) {
        return this.siteMapUris.indexOf(uri) == -1 &&
          _.pluck(this.workers, 'uri').indexOf(uri) == -1;
      }, this);

      return filteredUriPool.length > 0 ? filteredUriPool[0] : undefined;
    };

    this.addUriIntoSiteMapUris = function (uri) {
      this.siteMapUris.push(uri);
    };

    this.filterAndGraceLinks = function (links, previousUri) {
      var parsedUri = Url.parse(previousUri);

      var resultUris = _
        .map(links, function (link) {
          var _l;
          if (link.match(/^https?:\/\//)) {
            return link;
          } else if (link.match(/^\//)) {
            return parsedUri.protocol + '//' + parsedUri.host + link;
          } else if (link.match(/#/)) {
            return parsedUri.protocol + '//' +
              parsedUri.host +
              parsedUri.pathname.replace(/#[^\/]*$/, '') + link;
          } else {
            return parsedUri.protocol + '//' +
              parsedUri.host +
              parsedUri.pathname.replace(/\/[^\/]*$/, '/') +
              link;
          }
        })
        .filter(function (link) {
          return link.indexOf(parsedUri.protocol + '//' + parsedUri.host) == 0;
        })
        .filter(function (link) {
          return this.uriPool.indexOf(link) == -1 &&
            this.siteMapUris.indexOf(link) == -1 &&
            _.pluck(this.workers, 'uri').indexOf(link) == -1;
        }, this);

      return _.uniq(resultUris);
    };

    this.addWorkerInWorkerPool = function (worker) {
      this.workers.push(worker);
      logger.verbose('Worker added into worker-pool');
      logger.verbose('[workerAddedIntoPool] event emitted');
      this.emit('workerAddedIntoPool', {worker: worker});
    };

    this.removeWorkerFromWorkerPool = function (worker) {
      if (this.workers.length == 0) {
        logger.info('Worker pool is empty');
        return;
      }

      var indexOfWorker = this.workers.indexOf(worker);

      logger.info('Index of worker in array: ', indexOfWorker);

      if (indexOfWorker != -1) {
        this.workers.splice(indexOfWorker, 1);
        logger.verbose('[workerRemovedFromWorkerPool] event emitted');
        this.emit('workerRemovedFromWorkerPool');
      } else {
        logger.verbose('Worker not found in workers pool');
      }
    };

    //region EventHandlers
    this.on('jobRun', function () {
      logger.verbose('[jobRun] event handled');
      if (this.isBusy) {
        this.sendMessage('Another action in progress', 'error');
      } else {
        this.once('jobComplete', this.jobCompleteHandler);
        this.sendMessage('Run init', 'info');
        logger.verbose('Adding uri into poll');
        this.addUriIntoPool(this.targetSiteUri);
        logger.verbose('[workerRemovedFromWorkerPool] event synthetically emitted');
        this.emit('workerRemovedFromWorkerPool');
        this.isBusy = true;
      }
    });

    this.jobCompleteHandler = function () {
      logger.verbose('[jobComplete] event handled');
      this.isBusy = false;
      logger.info(this.siteMapUris);
      this.sendMessage('Job complete!', 'success');
    };

    this.on('dataFetched', function (event) {
      /** event {html, worker, uri, responseIsCorrect} */
      logger.verbose('Adding url to sitemap array');
      this.addUriIntoSiteMapUris(event.uri);
      logger.verbose('[dataFetched] event handled');

      logger.verbose('Removing parsed uri from uri pool');
      this.removeUriFromPool(event.uri);

      if (event.responseIsCorrect) {
        var previousUri = event.uri;

        var $ = cheerio.load(event.html);

        links = [];

        $('a[href]').map(function (index, element) {
          links.push($(element).attr('href'));
        });


        if (links && links.length) {
          var newUris = this.filterAndGraceLinks(links, previousUri);

          logger.verbose('Collected ' + newUris.length + 'new URIs');

          _.each(newUris, function (uri) {
            this.addUriIntoPool(uri);
          }, this);
        } else {
          logger.verbose('LINKS NOT FOUND TRY TO NEXT STEP');
        }
      }

      logger.verbose('Removing worker');
      this.removeWorkerFromWorkerPool(event.worker);
      logger.verbose('Removing uri from pool', event.uri);
      this.removeUriFromPool(event.uri);
    });

    this.on('workerRemovedFromWorkerPool', function () {
      var that = this;

      var countOfFreeWorkerPlaces = this.countOfWorkers - this.workers.length;

      _.times(Math.min(countOfFreeWorkerPlaces, this.uriPool.length), function () {
        var uri = this.getUriFromPool();

        if (uri) {
          var parsedUri = Url.parse(uri);

          logger.info(parsedUri);

          logger.verbose('Make worker..');
          var httpRequest = http.request({
            host: parsedUri.hostname,
            path: parsedUri.path
          }, function (response) {
            var data = '';

            response.on('data', function (chunk) {
              data += chunk;
            });

            response.on('end', function () {
              if (response.headers['content-type'].indexOf('text') != -1) {
                logger.verbose('[dataFetched] event emitted');
                that.emit('dataFetched', {html: data, worker: httpRequest, uri: uri, responseIsCorrect: true});
              } else {
                logger.verbose('[dataFetched] event emitted with wrong response');
                logger.warn('Wrong Content-type in response: ' + response.headers['content-type']);
                logger.warn('>>>', {uri: uri});
                that.emit('dataFetched', {html: data, worker: httpRequest, uri: uri});
              }
            });
          });
          httpRequest.uri = uri;

          httpRequest.end();
          that.addWorkerInWorkerPool(httpRequest);
        }
      }, this);
    });

    this.on('sendStatus', function () {
      this.sendStatus({
        countOfActiveWorkers: this.workers.length,
        urisInPool: this.uriPool.length,
        urisParsed: this.siteMapUris.length,
        isBusy: this.isBusy
      });
    });
    //endregion

    //region Send status emitting
    function emitSendStatus() {
      this.emit('sendStatus');
    }

    this.on('jobRun', emitSendStatus);
    this.on('jobComplete', emitSendStatus);
    this.on('uriPoolAdded', emitSendStatus);
    this.on('uriPoolRemoved', emitSendStatus);
    this.on('dataFetched', emitSendStatus);
    this.on('workerReady', emitSendStatus);
    this.on('workerAddedIntoPool', emitSendStatus);
    this.on('workerRemovedFromPool', emitSendStatus);
    this.on('run', emitSendStatus);
    this.on('interrupt', emitSendStatus);
    this.on('getStatus', emitSendStatus);
    //endregion

    //region Client Triggers
    this.on('run', function (event) {

      extend(this, {
        targetSiteUri: event.data.targetSiteUri,
        maxDepth: +event.data.maxDepth,
        countOfWorkers: +event.data.countOfWorkers,
        changeFreq: event.data.changeFreq,
        evaluatePriority: event.data.evaluatePriority,
        maxCountOfUrl: +event.data.maxCountOfUrl
      });
      //extend(this, event.data);

      logger.verbose('[jobRun] event emitted');
      this.emit('jobRun');
    });

    this.on('interrupt', function (event) {
      this.sendMessage('Job interrupted', 'info');
      logger.verbose('Interrupt event');
    });

    this.on('getStatus', function (event) {
      this.sendMessage('Status will return', 'success');
      logger.verbose('Get status event');
      logger.verbose('[sendStatus] event emitted');
      this.emit('sendStatus');
    });

    this.on('socket-disconnected', function () {
      logger.verbose('[socket-disconnected] event handled');
      clearTimeout(this.timer);
    });

    this.on('jobRun', function () {
      logger.verbose('[jobRun] event handled');
      logger.verbose('Starting timer for checking job status complete');
      setTimeout(function run() {
        logger.info('Try to check is job complete');

        if (this.isBusy &&
          this.workers.length == 0 &&
          this.uriPool.length == 0 &&
          this.siteMapUris.length > 0) {

          this.emit('jobComplete');
        } else {
          this.timer = setTimeout(run.bind(this), 2000);
        }
      }.bind(this), 2000);
    });
    //endregion

    this.timer = undefined;
  }

  util.inherits(SmMaker, EventEmitter);

  return SmMaker;
};