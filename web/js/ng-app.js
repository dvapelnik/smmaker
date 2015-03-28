(function (angular, validator) {
  angular.module('smmaker', ['angular-growl', 'angular-validator', 'ngWebSocket'])
    .config(['growlProvider', function (growlProvider) {
      growlProvider.globalReversedOrder(true);
      growlProvider.globalTimeToLive(5000);
    }])
    .controller('MainController', function ($scope, $websocket, growl, validateForm) {

      //region WebSocket
      var socket = $websocket('ws://localhost:30000');
      socket.onMessage(function (message) {
        var eventData = JSON.parse(message.data);

        $scope.$broadcast(eventData.action, eventData.data);
      });
      socket.onOpen(function () {
        $scope.socketIsConnected = true;
        $scope.$apply();
      });
      socket.onClose(function () {
        $scope.socketIsConnected = false;
        growl.error('Socket connection closed<br>Try to refresh page');
        $scope.$apply();
      });
      socket.onError(function () {
        addNewMessage('Socket connection error occurred<br>Try to refresh page');
        growl.warn('Socket connection error');
      });
      $scope.socketIsConnected = false;
      //endregion

      $scope.$on('message', function (event, data) {
        growl[data.type](data.message);
        addNewMessage(data.message);
      });
      $scope.$on('transfer', function (event, data) {
        growl.warning('Data transfered');
        console.log(data.data);
      });
      $scope.$on('update-status', function (event, data) {
        $scope.jobStatus = data.data;
      });
      $scope.$on('send-links', function (event, data) {
        $scope.sitemapLinks = data.data;
        $scope.$apply();
      });

      $scope.messages = [];

      $scope.sitemapLinks = [];

      $scope.jobStatus = {
        countOfActiveWorkers: 0,
        urisInPool: 0,
        urisParsed: 0,
        isBusy: false
      };

      $scope.getJobStatusObject = function () {
        var preparedCountUrisInQueue = $scope.jobStatus.urisInPool - $scope.jobStatus.countOfActiveWorkers;

        return {
          countOfActiveWorkers: $scope.jobStatus.countOfActiveWorkers,
          countUrisInQueue: preparedCountUrisInQueue < 0 ? 0 : preparedCountUrisInQueue,
          urisParsed: $scope.jobStatus.urisParsed,
          isBusy: $scope.jobStatus.isBusy
        }
      };

      $scope.chageFreqOptions = [
        //{value: 'auto', label: 'Auto'},
        {value: 'always', label: 'Always'},
        {value: 'hourly', label: 'Hourly'},
        {value: 'daily', label: 'Daily'},
        {value: 'weekly', label: 'Weekly'},
        {value: 'monthly', label: 'Monthly'},
        {value: 'yearly', label: 'Yearly'},
        {value: 'never', label: 'Never'}
      ];

      $scope.clearForm = function () {
        $scope.form = getInitialFormState();
      };

      $scope.interrupt = function () {
        socket.send(JSON.stringify({
          action: 'interrupt'
        }));
      };
      $scope.run = function () {
        if (validateForm($scope.form)) {
          socket.send(JSON.stringify({
            action: 'run',
            data: {
              targetSiteUri: $scope.form.targetSiteUri,
              maxNestingLevel: $scope.form.maxNestingLevel,
              countOfWorkers: $scope.form.countOfWorkers,
              changeFreq: $scope.form.changefreq.value,
              mbLengthLimit: $scope.form.mbLengthLimit,
              uriCountLimitPerFile: $scope.form.uriCountLimitPerFile,
              retrieveType: $scope.form.retrieveType,
              makeAPrettyXml: $scope.form.makeAPrettyXml,
              email: $scope.form.email
            }
          }));
        }
      };
      $scope.getStatus = function () {
        socket.send(JSON.stringify({
          action: 'getStatus'
        }));
      };

      $scope.clearForm();

      function getInitialFormState() {
        return {
          targetSiteUri: 'http://just-try-another.blogspot.nl/',
          //targetSiteUri: 'http://pmg17.vn.ua',
          maxNestingLevel: 2,
          countOfWorkers: 2,
          changefreq: $scope.chageFreqOptions[2],
          mbLengthLimit: 10,
          uriCountLimitPerFile: 50000,
          makeAPrettyXml: true,
          retrieveType: 'link',
          email: ''
        };
      }

      function addNewMessage(message) {
        $scope.messages.push(message);
        $scope.$apply();
      }
    })
    .filter('reverse', function () {
      return function (items) {
        return items.slice().reverse();
      };
    });

  angular.module('angular-validator', ['angular-growl'])
    .factory('validator', function () {
      return validator;
    })
    .factory('validateForm', function (growl) {
      return function (formData) {
        if (formData.targetSiteUri == '') {
          growl.error('Specify target site URI please');
          return false;
        }

        if (!validator.isURL(formData.targetSiteUri, {
            protocols: ['http', 'https'],
            require_protocol: true
          })) {
          growl.error('Input correct site address');
          return false;
        }

        if (!validator.isNumeric(formData.maxNestingLevel)) {
          growl.error('Max nesting level is not a numeric');
          return false;
        }

        if (!validator.isNumeric(formData.countOfWorkers)) {
          growl.error('Count of workers is not a numeric');
          return false;
        }

        if(formData.retrieveType == 'email' && formData.email == ''){
          growl.error('Input your email');
          return false;
        }

        return true;
      }
    });
})(window.angular, window.validator);