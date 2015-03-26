var _ = require('underscore');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var Url = require('url');
var extend = require('extend');
var Spooky;

try {
  Spooky = require('spooky');
} catch (e) {
  Spooky = require('../lib/spooky');
}

function SmMaker() {
  var spookyWorkerOptions = {
    child: {transport: 'http'},
    casper: {logLevel: 'debug', verbose: true}
  };

  //region Properties
  this.targetSiteUri = undefined;
  this.maxDepth = undefined;
  this.countOfWorkers = undefined;
  this.changeFreq = undefined;
  this.evaluatePriority = undefined;
  this.maxCountOfUrl = undefined;

  this.workers = [];
  this.siteMapUris = [];
  this.urlPool = [];

  this.isBusy = false;
  //endregion

  this.sendMessage = function (message, type) {
    this.connection.sendText(JSON.stringify({
      action: 'message',
      data: {
        message: message,
        type: type
      }
    }));
  };

  this.sendTransfer = function (transfer) {
    this.connection.sendText(JSON.stringify({
      action: 'transfer',
      data: {
        transfer: transfer
      }
    }));
  };

  this.parseUri = function () {
    var thisSmMaker = this;

    if (this.workers.length < this.countOfWorkers) {
      console.log('Create new worker');
      var worker = new Spooky(spookyWorkerOptions, function (error) {
        if (error) {
          thisSmMaker.emit('spookyInitError', error);
        } else {
          thisSmMaker.emit('parse', {worker: worker});
        }
      });

      this.workers.push(worker);

      worker.on('parsed', function (event) {
        event.uri = this.uri;

        thisSmMaker.emit('parsed', event);

        //var indexOfWorker = thisSmMaker.workers.indexOf(this);
        //if (indexOfWorker != -1) {
        //  thisSmMaker.workers.splice(indexOfWorker, 1);
        //  thisSmMaker.emit('workerFreed');
        //}
      });
      worker.on('workerJobFinish', function () {
        var indexOfWorker = thisSmMaker.workers.indexOf(this);
        if (indexOfWorker != -1) {
          thisSmMaker.workers.splice(indexOfWorker, 1);
          thisSmMaker.emit('workerFreed');

          console.log('WORKERS COUNT');
          console.log(thisSmMaker.workers.length);
        }
      });
      worker.on('error', function (e, stack) {
        console.error(e);
        if (stack) console.log(stack);
      });
      worker.on('console', function (line) {
        console.log(line);
      });
    }
  };

  this.parse = function (worker, uri) {
    console.log('>>> PARSING >>>> ' + uri);

    var thisSmMaker = this;

    worker.start(uri);
    worker.then(function () {
      this.emit('parsed', {
        //transfer: this.evaluate(function () {
        //  return document;
        //}),
        title: this.evaluate(function () {
          return document.title;
        }),
        links: this.evaluate(function () {
          var links = document.getElementsByTagName('a');
          links = Array.prototype.map.call(links, function (link) {
            return link.getAttribute('href');
          });
          return links;
        })
      });
    });
    worker.run(function () {
      this.emit('workerJobFinish');
    });
    worker.uri = uri;
  };

  this.start = function () {
    if (this.isBusy) {
      this.connection.sendText(JSON.stringify({
        action: 'message',
        data: {
          message: 'Another action in progress',
          type: 'error'
        }
      }));
    } else {
      this.isBusy = true;

      this.urlPool.push(this.targetSiteUri);
      this.emit('uriPoolAdded', {uri: this.targetSiteUri});
    }
  };

  this.getUriForParse = function () {
    if (this.urlPool.length > 0) {
      return this.urlPool.shift();
    } else {
      this.emit('jobComplete');
    }
  };

  this.on('workerFreed', function () {
    this.parseUri();
  });

  this.on('uriPoolAdded', function () {
    this.connection.sendText(JSON.stringify({
      action: 'message',
      data: {
        message: [
          'Count of workers: ' + this.workers.length,
          'UrlPoolLength: ' + this.urlPool.length,
          'Url parsed: ' + this.siteMapUris
        ].join('; '),
        type: 'info'
      }
    }));

    this.parseUri();
  });

  this.on('uriPoolRemoved', function () {
    if (this.urlPool.length == 0) {
      this.emit('jobComplete');
    }
  });

  this.on('jobComplete', function () {
    this.isBusy = false;
    this.connection.sendText(JSON.stringify({
      action: 'message',
      data: {
        message: 'Parsed!',
        type: 'success'
      }
    }))
  });

  this.on('spookyInitError', function (event) {
    this.connection.sendText(JSON.stringify({
      action: 'message',
      data: {
        message: 'Spooky initialization failed',
        type: 'warning'
      }
    }));
    this.connection.sendText(JSON.stringify({
      action: 'transfer',
      data: {
        transfer: event
      }
    }));
  });

  /**
   * event: { worker }
   */
  this.on('parse', function (event) {
    this.parse(event.worker, this.getUriForParse());
  });

  /**
   * event: { uri, title, links[] }
   */
  this.on('parsed', function (event) {
    var indexOfUri = this.urlPool.indexOf(event.uri);
    if (~indexOfUri) {
      this.urlPool.splice(indexOfUri, 1);
      this.emit('uriPoolRemoved');
    }

    this.siteMapUris.push(event.uri);

    //console.log(event.links);

    if (event.links && event.links.length) {
      var parsedUri = Url.parse(event.uri);

      var links = _
        .map(event.links, function (link) {
          //console.log(link);
          var _l;
          if (link.match(/^https?:\/\//)) {
            //console.log('Full link');
            return link;
          } else if (link.match(/^\//)) {
            //console.log('Absolute link');
            return parsedUri.protocol + '//' + parsedUri.host + link;
          } else if (link.match(/#/)) {
            //console.log('Hashed link');
            return parsedUri.protocol + '//' +
              parsedUri.host +
              parsedUri.pathname.replace(/#[^\/]*$/, '') + link;
          } else {
            //console.log('Relative link');
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
          return true;
        })
        .filter(function (link) {
          return this.urlPool.indexOf(link) == -1 && this.siteMapUris.indexOf(link) == -1;
        }, this);

      links = _.uniq(links);

      _.each(links, function (link) {
        this.urlPool.push(link);
        this.emit('uriPoolAdded', {uri: link});
      }, this);
    } else {
      console.log('-------------- LINKS NOT FOUND TRY TO NEXT STEP --------------');
      this.parseUri();
    }

    //console.log(links);
  });
}

/**
 * Client events:
 *    message: {
 *      action: 'message',
 *      data: {
 *        message: 'Some message',
 *        type: 'warning|info|success|error
 *      }
 *    }
 */

util.inherits(SmMaker, EventEmitter);

var smMaker = new SmMaker();
smMaker.setMaxListeners(100);

smMaker.on('run', function (event) {
  event.connection.sendText(JSON.stringify({
    action: 'message',
    data: {
      message: 'Run init',
      type: 'info'
    }
  }));
  extend(this, event.data);
  this.connection = event.connection;
  this.start();
});

smMaker.on('interrupt', function (event) {
  event.connection.sendText(JSON.stringify({
    action: 'message',
    data: {
      message: 'Job interrupted',
      type: 'info'
    }
  }));
  console.log('Interrupt event');
});

smMaker.on('getStatus', function (event) {
  event.connection.sendText(JSON.stringify({
    action: 'message',
    data: {
      message: 'Status returned',
      type: 'success'
    }
  }));
  console.log('Get status event');
});

smMaker.on('*', function () {
  console.log('>>> * Event >>>');
});

setInterval(function () {
  console.log('>>>> TIMER:');
  console.log('Workers: ' + smMaker.workers.length);
  console.log('Pool: ' + smMaker.urlPool.length);
  console.log('Parsed: ' + smMaker.siteMapUris.length);
}, 1000);

module.exports = smMaker;