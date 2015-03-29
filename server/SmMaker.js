var _ = require('underscore');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var Url = require('url');
var cheerio = require('cheerio');
var extend = require('extend');
var http = require('http');
var winston = require('winston');
var builder = require('xmlbuilder');
var async = require('async');
var fs = require('fs');
var nodemailer = require('nodemailer');
var normalizeurl = require('normalizeurl');
var request = require('request');

var unsupportedExts = [
  'js', 'css', 'bmp', 'jpg', 'jpeg',
  'gif', 'png', 'avi', 'flv', 'mp4',
  'swf', 'zip', 'rar', 'gz', 'tgz',
  'wmv', 'wma', 'mp3', 'ogg', 'flac'
];

function Uri(uri, level) {
  this.uri = uri;
  this.level = level;
}

module.exports = function (options) {
  var logger = options.logger;

  var transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: options.config.email.user,
      pass: options.config.email.pass
    }
  });

  function SmMaker(socketConnection) {
    //region Properties
    this.targetSiteUri = undefined;
    this.maxNestingLevel = undefined;
    this.countOfWorkers = undefined;
    this.changeFreq = undefined;
    this.mbLengthLimit = 0;
    this.uriCountLimitPerFile = 0;
    this.makeAPrettyXml = undefined;
    this.retrieveType = 'link';
    this.email = '';

    this.workers = [];
    this.siteMapUris = [];
    this.uriPool = [];

    this.socketConnection = socketConnection;

    this.isBusy = false;
    this.isInterrupted = false;
    //endregion

    //region Utilities
    this.sendMessage = function (message, type) {
      logger.verbose('Sending message', message, type);
      type = type || 'info';

      if (this.socketConnection.readyState == 1) {
        this.socketConnection.sendText(JSON.stringify({
          action: 'message',
          data: {
            message: message,
            type: type
          }
        }));
      } else {
        logger.info('Socket connection not ready for messaging');
      }
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

    this.sendLinks = function (links) {
      logger.verbose('Sending links', links);
      this.socketConnection.sendText(JSON.stringify({
        action: 'send-links',
        data: {
          data: links
        }
      }));
    };

    this.sendEmail = function (files, sendEmailCallback) {
      logger.verbose('Files for email received', files);

      var that = this;

      if (_.all(files, function (file) {
          return !!file;
        })) {
        transporter.sendMail({
          sender: options.config.email.mailOptions.from,
          to: that.email,
          subject: 'Sitemap: ' + that.targetSiteUri,
          text: '',
          attachments: _.map(files, function (path) {
            return {path: options.config.path.basePath + path}
          })
        }, function (error, info) {
          if (error) {
            logger.error(error);
          } else {
            logger.info('Mail sent');
            logger.info(info);
            that.sendMessage('Email sent', 'success');
            sendEmailCallback();
          }
        });
      }
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
      var minLevel = _.min(_.pluck(this.uriPool, 'level'));

      var filteredUriPool = _.filter(this.uriPool, function (uri) {
        return uri.level <= minLevel &&
          this.siteMapUris.indexOf(uri.uri) == -1 &&
          _.pluck(_.pluck(this.workers, 'uri'), 'uri').indexOf(uri.uri) == -1;
      }, this);

      return filteredUriPool.length > 0 ? filteredUriPool[0] : undefined;
    };

    this.addUriIntoSiteMapUris = function (uri) {
      this.siteMapUris.push(uri);
    };

    this.filterAndGraceLinks = function (links, previousUri) {
      var parsedUri = Url.parse(previousUri);

      links = _.filter(links, function (link) {
        return !!link;
      }).filter(function (link) {
        return link != '#';
      });

      logger.verbose(links);

      var resultUris = _
        .map(links, function (link) {
          var _l;
          if (link.match(/^https?:\/\//)) {
            _l = link;
          } else if (link.match(/^(\/){2}/)) {
            _l = parsedUri.protocol + link;
          } else if (link.match(/^\//)) {
            _l = parsedUri.protocol + '//' + parsedUri.host + link;
          } else if (link.match(/#/)) {
            _l = parsedUri.protocol + '//' +
            parsedUri.host +
            parsedUri.pathname.replace(/#[^\/]*$/, '') + link;
          } else {
            _l = parsedUri.protocol + '//' +
            parsedUri.host +
            parsedUri.pathname.replace(/\/[^\/]*$/, '/') +
            link;
          }

          return _l;
        })
        .filter(function (link) {
          return _.all(unsupportedExts, function (ext) {
            return !link.match(new RegExp('\.' + ext, 'i'));
          });
        })
        .filter(function (link) {
          return !link.match(/mailto/);
        })
        .filter(function (link) {
          return link.indexOf(parsedUri.protocol + '//' + parsedUri.host) == 0;
        })
        .filter(function (link) {
          return _.pluck(this.uriPool, 'uri').indexOf(link) == -1 &&
            _.pluck(this.siteMapUris, 'uri').indexOf(link) == -1 &&
            _.pluck(_.pluck(this.workers, 'uri'), 'uri').indexOf(link) == -1;
        }, this);

      logger.verbose(resultUris);

      return _.uniq(resultUris);
    };

    this.makeARequest = function () {
      var that = this;

      var uri = this.getUriFromPool();

      if (uri) {

        var httpRequest = request({
          uri: uri.uri,
          followRedirect: false,
          followAllRedirects: false
        }, function (error, response, body) {
          var responseIsCorrect = false;

          if (error) {
            logger.error(error);
          } else if (response.statusCode > 300 && response.statusCode < 400) {
            logger.warn(response.headers);

            logger.warn(Url.parse(response.headers.location));

            var parsedLocation = Url.parse(response.headers.location);
            var parsedPreUri = Url.parse(uri.uri);

            if (parsedLocation.hostname) {
              that.addUriIntoPool(new Uri(response.headers.location, 1));
              that.makeARequest();
            } else {
              that.addUriIntoPool(new Uri(
                parsedPreUri.protocol + '//' + parsedPreUri.hostname + parsedLocation.pathname, 1));
              that.makeARequest();
            }
          } else if (response.statusCode == 200) {
            responseIsCorrect = true;
          } else {
            logger.info('Response status code', response.statusCode);
            logger.info('Response headers', response.headers);
          }

          logger.verbose('[dataFetched] event emitted');
          logger.verbose('Response is correct', responseIsCorrect);
          that.emit('dataFetched', {html: body, worker: httpRequest, uri: uri, responseIsCorrect: responseIsCorrect});

        });
        httpRequest.uri = uri;

        that.addWorkerInWorkerPool(httpRequest);
      }
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

    this.clearPoolArrays = function (withSiteMapUris) {
      logger.verbose('Resetting all pools');
      this.workers = [];
      this.uriPool = [];

      if (withSiteMapUris) {
        this.siteMapUris = [];
      }
    };

    this.getByteLengthLimit = function () {
      return this.mbLengthLimit * 1024 * 1024 * 8;
    };

    this.getByteLengthOfString = function (string) {
      return 8 * string.length;
    };

    this.getCurrentDateString = function () {
      var now = new Date();
      var curr_date = now.getDate();
      var curr_month = now.getMonth() + 1;
      var curr_year = now.getFullYear();

      return curr_year + "-" +
        (curr_month < 10 ? ('0' + curr_month) : curr_month) + "-" +
        (curr_date < 10 ? ('0' + curr_date) : curr_date);
    };

    /**
     * <?xml version="1.0" encoding="UTF-8"?>
     * <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     *    <url>
     *       <loc>http://www.example.com/</loc>
     *       <lastmod>2005-01-01</lastmod>
     *       <changefreq>monthly</changefreq>
     *       <priority>0.8</priority>
     *    </url>
     * </urlset>
     *
     * @param uriArray
     */
    this.makeXmlString = function (uriArray) {
      xml = builder.create('urlset', {
        version: '1.0',
        encoding: 'UTF-8'
      });

      xml.attribute('xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9');

      var dateString = this.getCurrentDateString();

      _.each(uriArray, function (uri) {
        var url = xml.ele('url');


        url.ele('loc', {}, uri.uri);
        url.ele('lastmod', {}, dateString);
        url.ele('changefreq', {}, this.changeFreq);
        url.ele('priority', {}, (1 / uri.level).toString().substr(0, 3));
      }, this);

      return xml.end({pretty: this.makeAPrettyXml}).toString();
    };

    /**
     * <?xml version="1.0" encoding="UTF-8"?>
     * <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     *    <sitemap>
     *       <loc>http://www.example.com/sitemap1.xml.gz</loc>
     *       <lastmod>2004-10-01T18:23:17+00:00</lastmod>
     *    </sitemap>
     *    <sitemap>
     *       <loc>http://www.example.com/sitemap2.xml.gz</loc>
     *       <lastmod>2005-01-01</lastmod>
     *    </sitemap>
     * </sitemapindex>
     * @param sitemapList
     */
    this.makeXmlPartedSiteMapString = function (sitemapList) {
      xml = builder.create('sitemapindex', {
        version: '1.0', encoding: 'UTF-8'
      });

      xml.attribute('xmlns', 'http://www.sitemaps.org/schemas/sitemap/0.9');

      var dateString = this.getCurrentDateString();

      _.each(sitemapList, function (sitemap) {
        var sitemapEle = xml.ele('sitemapEle');
        sitemapEle.ele('loc', {}, this.targetSiteUri.replace(/\/?$/, '/') + sitemap);
        sitemapEle.ele('lastmod', {}, dateString);
      }, this);

      return xml.end({pretty: this.makeAPrettyXml}).toString();
    };
    //endregion

    //region EventHandlers
    this.on('jobRun', function () {
      logger.verbose('[jobRun] event handled');
      if (this.isBusy) {
        this.sendMessage('Another action in progress', 'error');
      } else {
        this.once('jobComplete', this.jobCompleteHandler);
        this.clearPoolArrays(true);
        this.sendMessage('Run init', 'info');
        logger.verbose('Adding uri into poll');
        this.addUriIntoPool(new Uri(this.targetSiteUri, 1));
        logger.verbose('[workerRemovedFromWorkerPool] event synthetically emitted');
        this.emit('workerRemovedFromWorkerPool');
        this.isBusy = true;
      }
    });

    this.jobCompleteHandler = function (event) {
      /** event {wasInterrupted} */
      event = event || {};

      if (event.wasInterrupted) {
        this.sendMessage('Job interrupted!', 'warning');
        logger.verbose('[workComplete] event emitted');
        this.emit('workComplete', event);
      } else {
        logger.verbose('[jobComplete] event handled');
        //this.isBusy = false;
        //logger.info(this.siteMapUris);
        this.sendMessage('Job complete!<br>Genearating sitemap file', 'success');
        logger.verbose('[generateSiteMap] event handled');
        this.emit('generateSiteMap');
      }
    };

    this.on('jobInterrupt', function () {
      logger.verbose('Aborting workers');
      _.each(this.workers, function (httpRequest) {
        httpRequest.abort();
        logger.verbose('Worker job aborted');
      });

      this.isInterrupted = true;

      this.clearPoolArrays();

      logger.verbose('[sendStatus] event emitted');
      this.emit('sendStatus');

      logger.verbose('[jobComplete] event emitted');
      this.emit('jobComplete', {wasInterrupted: true});
    });

    this.on('workComplete', function (event) {
      /** event {wasInterrupted} */
      event = event || {};

      this.sendMessage('Work complete', 'success');
      this.isBusy = false;

      this.clearPoolArrays();
      logger.verbose('[sendStatus] event emitted');
      this.emit('sendStatus');
    });

    this.on('generateSiteMap', function () {
      var that = this;

      logger.verbose('[generateSiteMap] event handled');

      var xml = this.makeXmlString(this.siteMapUris);

      logger.info(this.retrieveType);

      var currentUnixTimestamp = Date.now().toString();

      async.waterfall([
        function (callback) {
          fs.mkdir('web/sitemaps/' + currentUnixTimestamp, 0775, function (error) {
            if (error) {
              callback(error);
            } else {
              callback(null, currentUnixTimestamp);
            }
          })
        },
        function (currentUnixTimestamp, callback) {
          if (that.siteMapUris.length < that.uriCountLimitPerFile &&
            that.getByteLengthOfString(xml) < that.getByteLengthLimit()) {
            fs.writeFile(
              'web/sitemaps/' + currentUnixTimestamp + '/sitemap.xml',
              xml,
              function (error) {
                if (error) {
                  callback(error);
                } else {
                  callback(null, currentUnixTimestamp);
                }
              });
          } else {
            var pagesCount = Math.max(
              Math.ceil(
                that.siteMapUris.length / (that.siteMapUris.length < that.uriCountLimitPerFile ?
                  that.siteMapUris.length :
                  that.uriCountLimitPerFile)
              ),
              Math.ceil(
                that.getByteLengthOfString(xml) / (that.getByteLengthOfString(xml) < that.getByteLengthLimit() ?
                  that.getByteLengthOfString(xml) :
                  that.getByteLengthLimit()
                )));

            logger.info('Pages count', pagesCount);

            var itemsPerPage = Math.ceil(that.siteMapUris.length / pagesCount);
            logger.info('Items per page', itemsPerPage);

            var siteMapChunks = [];

            _siteMapUris = that.siteMapUris.slice();
            logger.verbose(_siteMapUris);

            for (var i = 0, j = _siteMapUris.length; i < j; i += itemsPerPage) {
              siteMapChunks.push(_siteMapUris.slice(i, i + itemsPerPage));
            }

            async.times(pagesCount, function (n, timesCallback) {
              fs.writeFile(
                'web/sitemaps/' + currentUnixTimestamp + '/sitemap' + (n + 1) + '.xml',
                that.makeXmlString(siteMapChunks[n]),
                function (error) {
                  if (error) {
                    timesCallback(error);
                  } else {
                    timesCallback(null, n + 1);
                  }
                }
              )
            }, function (error, results) {
              if (error) {
                callback(error);
              } else {
                fs.writeFile(
                  'web/sitemaps/' + currentUnixTimestamp + '/sitemap.xml',
                  that.makeXmlPartedSiteMapString(_.map(results, function (n) {
                    return 'sitemap' + n + '.xml';
                  })),
                  function (error) {
                    if (error) {
                      callback(error);
                    } else {
                      callback(null, currentUnixTimestamp);
                    }
                  });
              }
            });
          }
        }
      ], function (error, result) {
        logger.verbose('[sendSiteMap] event emitted');
        logger.info('Received result from async.waterfall', result);
        that.emit('sendSiteMap', {folder: result})
      });
    });

    this.on('dataFetched', function (event) {
      /** event {html, worker, responseIsCorrect} */

      logger.verbose('Removing parsed uri from uri pool');
      this.removeUriFromPool(event.uri);

      if (this.isInterrupted == false) {
        logger.verbose('Adding url to sitemap array');
        this.addUriIntoSiteMapUris(event.uri);
        logger.verbose('[dataFetched] event handled');

        if (event.responseIsCorrect &&
          (event.worker.uri.level < this.maxNestingLevel || this.maxNestingLevel === 0)) {
          var previousUri = event.worker.uri.uri;

          logger.verbose('Make a cheerio $');
          var $ = cheerio.load(event.html);

          logger.verbose(event.html);

          var links = [];

          logger.verbose('Make a aTag array');
          $('a').map(function (index, element) {
            console.log($(element).attr('href'));
            links.push($(element).attr('href'));
          });

          logger.verbose('Gracefulling....');
          if (links && links.length) {
            var newUris = this.filterAndGraceLinks(links, previousUri);

            logger.verbose('Collected ' + newUris.length + 'new URIs');

            _.each(newUris, function (uri) {
              this.addUriIntoPool(new Uri(uri, event.worker.uri.level + 1));
            }, this);
          } else {
            logger.verbose('LINKS NOT FOUND TRY TO NEXT STEP');
          }
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

      _.times(Math.min(countOfFreeWorkerPlaces, this.uriPool.length), this.makeARequest, this);

      if (this.isBusy &&
        this.workers.length == 0 &&
        this.uriPool.length == 0 &&
        this.siteMapUris.length > 0) {
        logger.verbose('[jobComplete] event emitted');
        this.emit('jobComplete');
      }
    });

    this.on('sendStatus', function () {
      this.sendStatus({
        countOfActiveWorkers: this.workers.length,
        urisInPool: this.uriPool.length,
        urisParsed: this.siteMapUris.length,
        isBusy: this.isBusy
      });
    });

    this.on('sendSiteMap', function (event) {
      logger.verbose('[sendSiteMap] event handled');
      /** event {folder} */
      var that = this;

      logger.verbose('Reading dir', event.folder);
      fs.readdir('web/sitemaps/' + event.folder, function (error, filelist) {
        if (error) {
          logger.error(error);
        } else {
          logger.info(filelist);
          if (filelist.length > 0) {
            if (that.retrieveType == 'link') {
              that.sendLinks(_.map(filelist, function (file) {
                return 'sitemaps/' + event.folder + '/' + file;
              }));
              that.emit('workComplete');
            } else if (that.retrieveType == 'email' && that.email) {
              that.sendEmail(_.map(filelist, function (file) {
                return 'web/sitemaps/' + event.folder + '/' + file;
              }), function () {
                that.emit('workComplete');
              });
            } else {
              logger.warn('No receive transport (link or email) not assigned');
            }
          } else {
            that.sendMessage('Sitemap folder is empty. Hm.. Strangely!', 'warning');
          }
        }
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
        maxNestingLevel: +event.data.maxNestingLevel,
        countOfWorkers: +event.data.countOfWorkers,
        changeFreq: event.data.changeFreq,
        mbLengthLimit: event.data.mbLengthLimit,
        uriCountLimitPerFile: event.data.uriCountLimitPerFile,
        makeAPrettyXml: event.data.makeAPrettyXml,
        retrieveType: event.data.retrieveType,
        email: event.data.email
      });
      //extend(this, event.data);

      logger.verbose('[jobRun] event emitted');
      this.emit('jobRun');
    });

    this.on('interrupt', function (event) {
      this.sendMessage('Job interrupting...', 'info');
      logger.verbose('Interrupt event');
      logger.verbose('[jobInterrupt] event emitted');
      this.emit('jobInterrupt');
    });

    this.on('getStatus', function (event) {
      this.sendMessage('Status will return', 'success');
      logger.verbose('Get status event');
      logger.verbose('[sendStatus] event emitted');
      this.emit('sendStatus');
    });

    this.on('socket-disconnected', function () {
      logger.verbose('[socket-disconnected] event handled');
      logger.verbose('[jobInterrupt] event emitted');
      this.emit('jobInterrupt');
    });
    //endregion
  }

  util.inherits(SmMaker, EventEmitter);

  return SmMaker;
};