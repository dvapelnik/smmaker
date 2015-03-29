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
var request = require('request');

var unsupportedExtensions = [
  'js', 'css', 'bmp', 'jpg', 'jpeg',
  'gif', 'png', 'avi', 'flv', 'mp4',
  'swf', 'zip', 'rar', 'gz', 'tgz',
  'wmv', 'wma', 'mp3', 'ogg', 'flac',
  'doc', 'docx', 'xls', 'xlsx', 'ppt',
  'pptx', 'xml', 'js', 'css', 'lass',
  'sass', 'less', '7z'
];

// Класс для формирования ссылок
function Uri(uri, level) {
  this.uri = uri;
  this.level = level;
}

module.exports = function (options) {
  var logger = options.logger;

  // Транспорт для отправки почты
  var transporter = nodemailer.createTransport({
    service: 'Gmail',
    auth: {
      user: options.config.email.user,
      pass: options.config.email.pass
    }
  });

  function SmMaker(socketConnection) {
    //region Properties
    // Ссылка на главную страницу
    this.targetSiteUri = undefined;
    // Количество вложенных уровней
    this.maxNestingLevel = undefined;
    // количетсво воркеров для асинхронного получения контентов от ссылок
    this.countOfWorkers = undefined;
    // относится к спецификации структуры сайтмапа
    this.changeFreq = undefined;
    // максимальный объем файла сайтмапа в мегабайтах
    this.mbLengthLimit = 0;
    // максимальное количество ссылок в сайтмапе
    this.uriCountLimitPerFile = 0;
    // создавать отформатированный XML-файл
    this.makeAPrettyXml = undefined;
    // каким образом отдавать сгенерированный сайтмап (link|email)
    this.retrieveType = 'link';
    // куда отправить сайтмап по по электронной почте
    this.email = '';

    // пуллы: воркеры, отработанные ссылки и пулл очереди на обработку
    this.workers = [];
    this.siteMapUris = [];
    this.uriPool = [];

    // соединение, открытое по веб-сокету
    this.socketConnection = socketConnection;

    // статусы: занят ли работой, прервана ли работа
    this.isBusy = false;
    this.isInterrupted = false;
    //endregion

    //region Utilities
    // единый метод для отправки данных по веб-сокету
    this.sendText = function (text) {
      // проверяем статус сокета и отправляем, если нет, то пишем об этом в консоль
      if (this.socketConnection.readyState == 1) {
        logger.verbose('Sending text via socket');
        this.socketConnection.sendText(text);
      } else {
        logger.verbose('Can\'t send text via socket');
        logger.verbose('Socker reary state', this.socketConnection.readyState);
      }
    };

    // далее обертки для отрправки сообщений на фронтед
    // отправка сообщения, которое будет показано гроулом
    this.sendMessage = function (message, type) {
      logger.verbose('Sending message', message, type);
      type = type || 'info';

      this.sendText(JSON.stringify({
        action: 'message',
        data: {
          message: message,
          type: type
        }
      }));
    };

    // отправка объекта, который будет дапиться в консоль браузера
    this.sendTransfer = function (transfer) {
      logger.verbose('Transferring data via socket');
      this.sendText(JSON.stringify({
        action: 'transfer',
        data: {
          data: transfer
        }
      }));
    };

    // отправка статуса
    this.sendStatus = function (statusObject) {
      logger.verbose('Sending status via socket');
      this.sendText(JSON.stringify({
        action: 'update-status',
        data: {
          data: statusObject
        }
      }));
    };

    // отправка ссылок на сгенерированный сайтмап
    this.sendLinks = function (links) {
      logger.verbose('Sending links', links);
      this.sendText(JSON.stringify({
        action: 'send-links',
        data: {
          data: links
        }
      }));
    };

    // отправка сайтмапа по почте
    this.sendEmail = function (files, sendEmailCallback) {
      logger.verbose('Files for email received', files);

      var that = this;

      // проверяем все ли полученные имена файлов сайтмапа дейсвтительно являются файлами
      if (_.all(files, function (file) {
          return !!file;
        })) {
        // отправляем файлы почтой
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

    // добавление ссылки в пулл очереди с генерацией соответствующего события
    this.addUriIntoPool = function (uri) {
      this.uriPool.push(uri);
      logger.verbose('[uriPoolAdded] event emitted');
      this.emit('uriPoolAdded', {uri: uri});
    };

    // удаление ссылки из пулла очереди если такая ссылка есть в очереди
    this.removeUriFromPool = function (uri) {
      if (this.uriPool.length == 0) return;

      var indexOfUri = this.uriPool.indexOf(uri);

      if (indexOfUri != -1) {
        this.uriPool.splice(indexOfUri, 1);

        this.emit('uriPoolRemoved', {uri: uri});
      }
    };

    // логика получения следуюющей ссылки из очереди
    // в данном варианте берутся ссылки по уровню вложенности
    // сначала отдаются ссылки меньшей вложенности
    // так как они более приоритетны для обработки
    // в принципе, можно отдавать эти ссылки рендомно
    // если отдавать упорядоченно по уровню вложенности, то
    // бывают такие моменты когда в пулле воркеров обрабатывается только одна ссылка
    // есдинственным воркером и после того, как она заканчивает обрабатываться
    // пулл воркеров заполянется воркерами, которые обрабатывают новый уровень
    // вложенности
    this.getUriFromPool = function () {
      var minLevel = _.min(_.pluck(this.uriPool, 'level'));

      var filteredUriPool = _.filter(this.uriPool, function (uri) {
        return uri.level <= minLevel &&
          this.siteMapUris.indexOf(uri.uri) == -1 &&
          _.pluck(_.pluck(this.workers, 'uri'), 'uri').indexOf(uri.uri) == -1;
      }, this);

      return filteredUriPool.length > 0 ? filteredUriPool[0] : undefined;
    };

    // добавление ссылки в пулл обработанных ссылок на сайтмап
    this.addUriIntoSiteMapUris = function (uri) {
      if(uri.level == 1){
        this.targetSiteUri = uri.uri;
      }
      this.siteMapUris.push(uri);
    };

    // фильтрование и приведение линков к виду полных ссылок
    this.filterAndGraceLinks = function (links, previousUri) {
      var parsedUri = Url.parse(previousUri);

      links = _.filter(links, function (link) {
        // на всякие случай фильтруем не пустая ли это строка вообще
        return !!link;
      }).filter(function (link) {
        // пропускаем все ссылки, которые состоят только из диеза
        return link != '#';
      });

      logger.verbose(links);

      var resultUris = _
        .map(links, function (link) {
          var _l;
          if (link.match(/^https?:\/\//)) {
            // если это полная ссылка, то возвращает просто ссылку
            _l = link;
          } else if (link.match(/^(\/){2}/)) {
            // если это ссылка вида //domain.com/foo/bar/baz
            // то добавляем протокол
            _l = parsedUri.protocol + link;
          } else if (link.match(/^\//)) {
            // полная ссылка - добавляем протокол и домен
            _l = parsedUri.protocol + '//' + parsedUri.host + link;
          } else if (link.match(/#/)) {
            // если хеш, то формируем полную ссылки
            _l = parsedUri.protocol + '//' +
            parsedUri.host +
            parsedUri.pathname.replace(/#[^\/]*$/, '') + link;
          } else {
            // остаются только относительные ссылки
            _l = parsedUri.protocol + '//' +
            parsedUri.host +
            parsedUri.pathname.replace(/\/[^\/]*$/, '/') +
            link;
          }

          return _l;
        })
        .filter(function (link) {
          // фильруем расширения
          return _.all(unsupportedExtensions, function (ext) {
            return !link.match(new RegExp('\.' + ext + '$', 'i'));
          });
        })
        .filter(function (link) {
          // фильтруем мейлтушки, скайп, телефон и JS
          return !link.match(/(mailto|skype|tel|javascript):/);
        })
        .filter(function (link) {
          // фильтруем внешние ссылки{
          return link.indexOf(parsedUri.protocol + '//' + parsedUri.host) == 0;
        })
        .filter(function (link) {
          // фильтруем ссылки, которые уже добалены в пуллы
          return _.pluck(this.uriPool, 'uri').indexOf(link) == -1 &&
            _.pluck(this.siteMapUris, 'uri').indexOf(link) == -1 &&
            _.pluck(_.pluck(this.workers, 'uri'), 'uri').indexOf(link) == -1;
        }, this);

      logger.verbose(resultUris);

      return _.uniq(resultUris);
    };

    // формирование и запуск запроса по ссылке
    this.makeARequest = function () {
      var that = this;

      // получаем ссылку из пулла очереди
      var uri = this.getUriFromPool();

      if (uri) {
        // делаем запрос
        var httpRequest = request({
          uri: uri.uri,
          timeout: 10000,
          followRedirect: false,
          followAllRedirects: false,
          headers: {
            'User-Agent': 'Mozilla /5.0 (Compatible MSIE 9.0;Windows NT 6.1;WOW64; Trident/5.0)'
          }
        }, function (error, response, body) {
          var responseIsCorrect = false;

          if (response) {
            logger.debug(response.headers['content-type']);
          }

          if (error) {
            // пишем об ошибке в консоль сервер
            logger.error(error);
            // если возникла ошибка опревышении таймаута, то следует об этом сообщить на фроненд
            if (error.code == 'ETIMEDOUT') {
              that.sendMessage('Request error: ' + error.code, 'error');
            }
          } else if (response.statusCode > 300 && response.statusCode < 400) {
            // попадаем на редирект
            logger.warn(response.headers);

            logger.warn(Url.parse(response.headers.location));

            var parsedLocation = Url.parse(response.headers.location);
            var parsedPreUri = Url.parse(uri.uri);

            if (parsedLocation.hostname) {
              // редирект, в котором указана полная ссылка с доменом и протоколом
              // возможно, внешняя
              // добавляем эту ссылку в пулл
              that.addUriIntoPool(new Uri(response.headers.location, uri.level));
              // рекурсивно составляем новый запрос
              // он должен взять эту ссылку из пулла и запустить ее
              that.makeARequest();
            } else {
              // редирект отновительно ресурса
              // добавляем в пулл очереди
              that.addUriIntoPool(new Uri(
                parsedPreUri.protocol + '//' + parsedPreUri.hostname + parsedLocation.pathname, uri.level));
              // делаем запрос
              that.makeARequest();
            }
          } else if (response.statusCode == 200) {
            // все хорошо, нужно обработать ответ и получить ссылки
            logger.verbose('All good', response.statusCode);
            // все хороше только тогда, если ответ пришел в контент-тайпом text/html
            responseIsCorrect =
              (response && (response.headers['content-type'] ||
              response.headers['content-type'].indexOf('text/html') == 0));
            // в ином случае мы не должны отрабатываеть ответ
          } else {
            // обо всем, что не поймали пишем в лог
            logger.info('Response status code', response.statusCode);
            logger.info('Response headers', response.headers);
          }

          logger.verbose('[dataFetched] event emitted');
          logger.verbose('Response is correct', responseIsCorrect);
          // говорим, что мы получили ответ и можно его дальше обрабатывать
          that.emit('dataFetched', {
            html: body,
            worker: httpRequest,
            uri: uri,
            responseIsCorrect: responseIsCorrect
          });

        });
        // дополнительно тегируем каждый запрос его ссылочкой
        httpRequest.uri = uri;

        // добавляем воркер в пулл воркеров
        that.addWorkerInWorkerPool(httpRequest);
      }
    };

    // добавляем воркера в пулл и говорим об этом
    this.addWorkerInWorkerPool = function (worker) {
      this.workers.push(worker);
      logger.verbose('Worker added into worker-pool');
      logger.verbose('[workerAddedIntoPool] event emitted');
      this.emit('workerAddedIntoPool', {worker: worker});
    };

    // удаляем воркера из пулла и говорим об этом - возможно, кому-то это нужно
    // а это кому-то, дейсвительно, нужно
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

    // очищаем пуллы. это нужно для прерывания работы и очистки перед начало работы
    this.clearPoolArrays = function (withSiteMapUris) {
      logger.verbose('Resetting all pools');
      this.workers = [];
      this.uriPool = [];

      if (withSiteMapUris) {
        this.siteMapUris = [];
      }
    };

    // прикидываем лимит объема файла в байтах
    this.getByteLengthLimit = function () {
      return this.mbLengthLimit * 1024 * 1024 * 8;
    };

    // прикидываем сколько будет весить XML файл в кодировкой UTF8 в байтах
    // нужно для сравнивания
    this.getByteLengthOfString = function (string) {
      return 8 * string.length;
    };

    // получение даты в формате YYYY-MM-DD
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
    // формирование XML-строки для сайтмапа
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
      // формирование XML-строки для порционного сайтмапа
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
    // работа начинается
    this.on('jobRun', function () {
      logger.verbose('[jobRun] event handled');
      if (this.isBusy) {
        // если работа уже начата, то извиняемся и отправляем сообщение на фроненд
        this.sendMessage('Another action in progress', 'error');
      } else {
        // подписываемся на событае завершения работы
        this.once('jobComplete', this.jobCompleteHandler);
        // очищаем пуллы
        this.clearPoolArrays(true);
        // сообщаем о том, что начали работать на фронт-энд
        this.sendMessage('Run init', 'info');
        logger.verbose('Adding uri into poll');
        // добавялем первую ссылку в работу
        this.addUriIntoPool(new Uri(this.targetSiteUri, 1));
        logger.verbose('[workerRemovedFromWorkerPool] event synthetically emitted');
        // синтетически начинаем работу
        this.emit('workerRemovedFromWorkerPool');
        this.isBusy = true;
      }
    });

    // хендлер для обработки завершения распарсивания страниц
    this.jobCompleteHandler = function (event) {
      /** event {wasInterrupted} */
      event = event || {};

      if (event.wasInterrupted) {
        // если вдруг работы была прервана, то сообщаем на фроненд
        this.sendMessage('Job interrupted!', 'warning');
        logger.verbose('[workComplete] event emitted');
        // говорим, что работа завершена
        this.emit('workComplete', event);
      } else {
        // если мы действительно нормально завершили работу
        logger.verbose('[jobComplete] event handled');
        // говорим об этом на фронтенде
        this.sendMessage('Job complete!<br>Genearating sitemap file', 'success');
        logger.verbose('[generateSiteMap] event handled');
        // генерируем событие для генерации файлов сайтмапа
        this.emit('generateSiteMap');
      }
    };

    // прерывание работы
    this.on('jobInterrupt', function () {
      logger.verbose('Aborting workers');
      _.each(this.workers, function (httpRequest) {
        // останавливаем работу всех воркероа
        httpRequest.abort();
        logger.verbose('Worker job aborted');
      });

      this.isInterrupted = true;

      // очищаем пуллы
      this.clearPoolArrays();

      logger.verbose('[sendStatus] event emitted');
      // обновляем статус на фронтенде
      this.emit('sendStatus');

      logger.verbose('[jobComplete] event emitted');
      // генерируем событие чтобы сообщить о том, что работа была завершена с прерыванием
      this.emit('jobComplete', {wasInterrupted: true});
    });

    // итак, мы закончили работу полностью и даже отправили сайтмап куда надо
    this.on('workComplete', function (event) {
      /** event {wasInterrupted} */
      event = event || {};

      // сообщаем на фронтэнд
      this.sendMessage('Work complete', 'success');
      this.isBusy = false;

      // очищаем пуллы
      this.clearPoolArrays();
      logger.verbose('[sendStatus] event emitted');
      // обновляем статус на фроненде
      this.emit('sendStatus');
    });

    // генерируем мсайтмап
    this.on('generateSiteMap', function () {
      var that = this;

      logger.verbose('[generateSiteMap] event handled');

      // унифицируем список ссылок для генерации фронтэнда
      this.siteMapUris = _.uniq(this.siteMapUris);

      logger.info(this.retrieveType);

      // нужно для содания папки для сайтмапа
      var currentUnixTimestamp = Date.now().toString();

      async.waterfall([
        function (callback) {
          // создаем папку для сайтмапа
          fs.mkdir('web/sitemaps/' + currentUnixTimestamp, 0775, function (error) {
            if (error) {
              callback(error);
            } else {
              callback(null, currentUnixTimestamp);
            }
          })
        },
        function (currentUnixTimestamp, callback) {
          // проверяем укладываемся ли мы в лимиты по объему и количеству ссылок
          if (that.siteMapUris.length < that.uriCountLimitPerFile &&
            that.getByteLengthOfString(xml) < that.getByteLengthLimit()) {
            // если мы укладываемся, то генерируем ОДИН файл

            // генерируем XML-строку
            var xml = that.makeXmlString(that.siteMapUris);
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
            // а вот тут мы не вписались в лимиты сайтмапа
            // потому должны разделить весь наш ворох на куски
            // получаем количетсво "страниц"
            var pagesCount = Math.max(
              // узнаем не помещаемся ли мы по количеству ссылок в файле
              Math.ceil(
                that.siteMapUris.length / (that.siteMapUris.length < that.uriCountLimitPerFile ?
                  that.siteMapUris.length :
                  that.uriCountLimitPerFile)
              ),
              // или мы не помещаемся по объему файла
              Math.ceil(
                that.getByteLengthOfString(xml) / (that.getByteLengthOfString(xml) < that.getByteLengthLimit() ?
                  that.getByteLengthOfString(xml) :
                  that.getByteLengthLimit()
                )));

            logger.info('Pages count', pagesCount);

            // считаем сколько должно быть ссылок на одну "странцу"
            var itemsPerPage = Math.ceil(that.siteMapUris.length / pagesCount);
            logger.info('Items per page', itemsPerPage);

            var siteMapChunks = [];

            // на всякий случай делаем копию собранных ссылок и дальше будем работать с ней
            _siteMapUris = that.siteMapUris.slice();
            logger.verbose(_siteMapUris);

            // собственно, делим на порции
            for (var i = 0, j = _siteMapUris.length; i < j; i += itemsPerPage) {
              siteMapChunks.push(_siteMapUris.slice(i, i + itemsPerPage));
            }

            async.times(pagesCount, function (n, timesCallback) {
              // каждый полученный кусок ссылок пишем в файл
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
              // по завершению сохранения кусокв в файлы генерируем ндексный файл сайтмапа
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
        // мы закончили генерацию фала (файлов) сайтмапа и готовы его отправить пользователю
        logger.verbose('[sendSiteMap] event emitted');
        logger.info('Received result from async.waterfall', result);
        // генерируем событие для отправки сайтмапа клиенту
        that.emit('sendSiteMap', {folder: result})
      });
    });

    // на этом этапе запрос к ссылочке обработался и можно обрабатывать ответ
    this.on('dataFetched', function (event) {
      /** event {html, worker, responseIsCorrect} */
      logger.verbose('[dataFetched] event handled');

      logger.verbose('Removing parsed uri from uri pool');
      // удаляем обработанную ссылку из пулла очереди
      this.removeUriFromPool(event.uri);

      // если работа вцелом не прервана - предотвращаем добавление новых ссылок в пулл очереди
      if (this.isInterrupted == false) {
        // если запрос нормальн отработал - в противном случае это отвер с редиректом или ошибкой
        if (event.responseIsCorrect) {
          logger.verbose('Adding url to sitemap array');
          // добавляем отработанную ссылочку в пулл ссылочек на саймап
          this.addUriIntoSiteMapUris(event.uri);

          // проверяем уровено вложенности
          if (event.worker.uri.level < this.maxNestingLevel || this.maxNestingLevel === 0) {
            // если все ОК с вложенностью и другими моментами (см. выше), то парсим ссылки,
            // фильтруем их и добавляем в пулл очереди
            var previousUri = event.worker.uri.uri;

            logger.verbose('Make a cheerio $');
            var $ = cheerio.load(event.html);

            //logger.debug(event.html);

            var links = [];

            logger.verbose('Make a aTag array');
            // ищем все ссылки
            $('a').map(function (index, element) {
              console.log($(element).attr('href'));
              // добавляем в промежуточный массив
              links.push($(element).attr('href'));
            });

            logger.verbose('Gracefulling....');
            if (links && links.length) {
              // приводим ссылки к нормальнму виду URL => URI
              var newUris = this.filterAndGraceLinks(links, previousUri);

              logger.verbose('Collected ' + newUris.length + 'new URIs');

              _.each(newUris, function (uri) {
                // добавляем каждую ссылочку в пулл очереди
                this.addUriIntoPool(new Uri(uri, event.worker.uri.level + 1));
              }, this);
            } else {
              // странно, но новых ссылок не было найдено
              // скорее всего, они все отфильтровались
              logger.verbose('LINKS NOT FOUND TRY TO NEXT STEP');
            }
          }
        }
      }

      logger.verbose('Removing worker');
      // удаляем воркера из пулла воркеров
      this.removeWorkerFromWorkerPool(event.worker);
      logger.verbose('Removing uri from pool', event.uri);
      // удаляем ссылочку и пулла очереди
      this.removeUriFromPool(event.uri);
    });

    // понимаем, что в пулле воркеров освободилось место
    // значит, мы можем добавить новых
    this.on('workerRemovedFromWorkerPool', function () {
      var that = this;

      // считаем сколько места есть пулле воркеров
      var countOfFreeWorkerPlaces = this.countOfWorkers - this.workers.length;

      // сколько есть мест в пулле - столько воркеров и добавляем
      _.times(Math.min(countOfFreeWorkerPlaces, this.uriPool.length), this.makeARequest, this);

      // проверяем, а вдруг мы уже закончили работу
      if (this.isBusy &&
        this.workers.length == 0 &&
        this.uriPool.length == 0) {
        logger.verbose('[jobComplete] event emitted');
        // говорим, что мы работу закончили
        this.emit('jobComplete');
      }
    });

    // нас попросили отправить статус на фронт-энд - мы его отправляем
    this.on('sendStatus', function () {
      this.sendStatus({
        countOfActiveWorkers: this.workers.length,
        urisInPool: this.uriPool.length,
        urisParsed: this.siteMapUris.length,
        isBusy: this.isBusy
      });
    });

    // нас попросили отравить сайтмап получателя
    this.on('sendSiteMap', function (event) {
      logger.verbose('[sendSiteMap] event handled');
      /** event {folder} */
      var that = this;

      // проверяем не пуст ли сайтмал - если пуст, то нам не нужно его отправлять
      if (this.siteMapUris.length) {
        logger.verbose('Reading dir', event.folder);
        // получаем список файлов в указанной папке
        fs.readdir('web/sitemaps/' + event.folder, function (error, filelist) {
          if (error) {
            // ошибка работы с файловой системой
            logger.error(error);
          } else {
            // получили список файлов
            logger.info(filelist);
            // првоеряем или он непуст
            if (filelist.length > 0) {
              // смотрим куда нужно отправить сатмап
              if (that.retrieveType == 'link') {
                // нужно отрпрвить пользователю в браузер
                // отправляем в браузер
                that.sendLinks(_.map(filelist, function (file) {
                  return 'sitemaps/' + event.folder + '/' + file;
                }));
                // говорим, что работа полностью завершена
                that.emit('workComplete');
              } else if (that.retrieveType == 'email' && that.email) {
                // нужно отравить сайтмап почтой
                // отправляем почтой
                that.sendEmail(_.map(filelist, function (file) {
                  return 'web/sitemaps/' + event.folder + '/' + file;
                }), function () {
                  // говорим, что работа завершена
                  that.emit('workComplete');
                });
              } else {
                // странно, ни одного метода отправки не обраружено
                logger.warn('No receive transport (link or email) not assigned');
                // все равно говорим, что работа завершена
                that.emit('workComplete');
              }
            } else {
              // странно: папка пуста
              that.sendMessage('Sitemap folder is empty. Hm.. Strangely!', 'warning');
            }
          }
        });
      } else {
        this.sendMessage('Sitemap url list is empty. Try to again.', 'warning');
        // так получилось, что сайтмап пуст
        // говорим, что работа завершена
        this.emit('workComplete');
      }
    });
    //endregion

    //region Send status emitting
    // раздел, которым мы генерируем события для оповещения фронэнда о статусе работы
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
    // ловим событие начала работы
    // оно транслируется через веб-сокет с фроненда
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

    // нужно прервать работу
    // оно может транслироваться через веб-сокет с фроненда
    this.on('interrupt', function (event) {
      this.sendMessage('Job interrupting...', 'info');
      logger.verbose('Interrupt event');
      logger.verbose('[jobInterrupt] event emitted');
      this.emit('jobInterrupt');
    });

    // нужно вернуть статус работы
    // оно транслируется через веб-сокет с фроненда
    this.on('getStatus', function (event) {
      this.sendMessage('Status will return', 'success');
      logger.verbose('Get status event');
      logger.verbose('[sendStatus] event emitted');
      this.emit('sendStatus');
    });

    // оборвалось соединение с клиентом - нужно прервать работу
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