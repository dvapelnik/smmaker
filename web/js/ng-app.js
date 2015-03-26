(function (angular, validator) {
  angular.module('smmaker', ['angular-growl', 'angular-validator'])
    .config(['growlProvider', function (growlProvider) {
      growlProvider.globalReversedOrder(true);
      growlProvider.globalTimeToLive(5000);
    }])
    .controller('MainController', function ($scope, WebSocketFactory, growl, validateForm) {
      var wsLink = 'ws://localhost:30000';
      var wsEventHandlers = {
        onopen: function () {
          addNewMessage('Opened');
        },
        onmessage: function (event) {
          var eventData = JSON.parse(event.data);

          $scope.$broadcast(eventData.action, eventData.data);
        },
        onerror: function () {
          addNewMessage('Error occurred');
          setTimeout(function () {
            socket = WebSocketFactory.create(wsLink, wsEventHandlers)
          }, 500);
        },
        onclose: function () {
          addNewMessage('Socket closed. Trying to reconnect');
          setTimeout(function () {
            socket = WebSocketFactory.create(wsLink, wsEventHandlers)
          }, 500);
        }
      };
      var socket = WebSocketFactory.create(wsLink, wsEventHandlers);

      $scope.$on('message', function (event, data) {
        growl[data.type](data.message);
        addNewMessage(data.message);
      });
      $scope.$on('transfer', function (event, data) {
        growl.warning('Data transfered');
        console.log(data.data);
      });

      $scope.messages = [];

      $scope.chageFreqOptions = [
        {value: 'auto', label: 'Auto'},
        {value: 'always', label: 'Always'},
        {value: 'hourly', label: 'Hourly'},
        {value: 'daily', label: 'Daily'},
        {value: 'weekly', label: 'Weekly'},
        {value: 'monthly', label: 'Monthly'},
        {value: 'yearly', label: 'Yearly'},
        {value: 'never', label: 'Never'}
      ];

      function getInitialFormState() {
        return {
          targetSiteUri: 'http://pmg17.vn.ua',
          maxDepth: 2,
          countOfWorkers: 2,
          changefreq: $scope.chageFreqOptions[0],
          evaluatePriority: false,
          maxCountOfUrl: 10
        };
      }

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
              maxDepth: $scope.form.maxDepth,
              countOfWorkers: $scope.form.countOfWorkers,
              changeFreq: $scope.form.changefreq.value,
              evaluatePriority: $scope.form.evaluatePriority,
              maxCountOfUrl: $scope.maxCountOfUrl
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

      function addNewMessage(message) {
        $scope.messages.push(message);
        $scope.$apply();
      }
    })
    .factory('WebSocketFactory', function () {
      return {
        socket: undefined,
        create: function (link, eventHandlers) {
          var socket = new WebSocket(link);

          angular.extend(socket, eventHandlers);

          return socket;
        }
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

        if (!validator.isNumeric(formData.maxDepth)) {
          growl.error('Max depth is not a numeric');
        }

        if (!validator.isNumeric(formData.countOfWorkers)) {
          growl.error('Count of workers is not a numeric');
        }

        return true;
      }
    });
})(window.angular, window.validator);