'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const bodyParser = require('body-parser');
const envvar = require('envvar');
const exphbs = require('express-handlebars');
const express = require('express');
const session = require('cookie-session');
const smartcar = require('smartcar');
const opn = require('opn');
const url = require('url');
const validator = require('validator');
// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded());
// // in latest body-parser use like below.
// app.use(bodyParser.urlencoded({ extended: true }));

// Set Smartcar configuration
const PORT = envvar.number('PORT', 8000);
const SMARTCAR_CLIENT_ID = envvar.string('SMARTCAR_CLIENT_ID');
const SMARTCAR_SECRET = envvar.string('SMARTCAR_SECRET');

var state = { test: 'test' };

// Validate Client ID and Secret are UUIDs
if (!validator.isUUID(SMARTCAR_CLIENT_ID)) {
  throw new Error(
    'CLIENT_ID is invalid. Please check to make sure you have replaced CLIENT_ID with the Client ID obtained from the Smartcar developer dashboard.'
  );
}

if (!validator.isUUID(SMARTCAR_SECRET)) {
  throw new Error(
    'SMARTCAR_SECRET is invalid. Please check to make sure you have replaced SMARTCAR_SECRET with your Client Secret obtained from the Smartcar developer dashboard.'
  );
}

// Redirect uri must be added to the application's allowed redirect uris
// in the Smartcar developer portal
const SMARTCAR_REDIRECT_URI = envvar.string(
  'SMARTCAR_REDIRECT_URI',
  `http://localhost:${PORT}/callback`
);

// Setting MODE to "development" will show Smartcar's mock vehicle
const SMARTCAR_MODE = envvar.oneOf(
  'SMARTCAR_MODE',
  ['development', 'production'],
  'production'
);

// Initialize Smartcar client
const client = new smartcar.AuthClient({
  clientId: SMARTCAR_CLIENT_ID,
  clientSecret: SMARTCAR_SECRET,
  redirectUri: SMARTCAR_REDIRECT_URI,
  development: SMARTCAR_MODE === 'development'
});

/**
 * Configure express server with handlebars as the view engine.
 */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  session({
    name: 'demo-session',
    secret: 'super-duper-secret'
  })
);

app.use(express.static('public'));

app.use(
  bodyParser.urlencoded({
    extended: false
  })
);

app.engine(
  '.hbs',
  exphbs({
    defaultLayout: 'main',
    extname: '.hbs'
  })
);

app.set('view engine', '.hbs');

/**
 * Render home page
 */
app.get('/', function(req, res, next) {
  //console.log(initMap('1355 Market St #900, San Francisco, CA 94103','200 Larkin St, San Francisco, CA 94102'));
  res.render('home', {
    authUrl: client.getAuthUrl()
  });
});

/**
 * Retrieve user address information and redirect to Smartcar
 */
app.post('/address', function(req, res) {
  state.address = req.body;
  console.log(state);
  res.redirect(client.getAuthUrl());
});

/**
 * Called on return from the Smartcar authorization flow. This route extracts
 * the authorization code from the url and exchanges the code with Smartcar
 * for an access token that can be used to make requests to the vehicle.
 */
app.get('/callback', function(req, res, next) {
  const code = _.get(req, 'query.code');
  if (!code) {
    return res.redirect('/');
  }

  // Exchange authorization code for access token
  client
  .exchangeCode(code)
  .then(function(access) {
    req.session = {};
    req.session.vehicles = {};
    req.session.access = access;
    return res.redirect('/market');
  })
  .catch(function(err) {
    const message = err.message || `Failed to exchange authorization code for access token`;
    const action = 'exchanging authorization code for access token';
    return redirectToError(res, message, action);
  });
});

/**
 * Display market to select delivery options
 */
app.get('/market', function(req, res, next) {
  const { access, vehicles } = req.session;
  state.access = access;
  if (!access) {
    return res.redirect('/');
  }

  smartcar.getVehicleIds(state.access.accessToken).then(function(data) {
    const vehicleIds = data.vehicles;
    const accessToken = state.access.accessToken
    const vehiclePromises = vehicleIds.map(vehicleId => {
      const vehicle = new smartcar.Vehicle(vehicleId, accessToken);
      req.session.vehicles[vehicleId] = {
        id: vehicleId
      };
      return vehicle.info();
    });

    return Promise.all(vehiclePromises)
    .then(function(data) {
      // Add vehicle info to vehicle objects
      _.forEach(data, vehicle => {
        const { id: vehicleId } = vehicle;
        req.session.vehicles[vehicleId] = vehicle;
      });

      // Update STATE
      state.vehicle = req.session.vehicles[Object.keys(req.session.vehicles)[0]];

      // Render
      console.log(state);
      res.render('market', {
        address: state.address,
        vehicles: state.vehicles,
        test: state.test
      });
    })
    .catch(function(err) {
      const message = err.message || 'Failed to get vehicle info.';
      const action = 'fetching vehicle info';
      return redirectToError(res, message, action);
    });
  });
});

/**
 * Triggers a request to the vehicle and renders the response.
 */
app.post('/delivery', function(req, res, next) {
  const instance = new smartcar.Vehicle(
    state.vehicle.id,
    state.access.accessToken
  );

  const homeAddress = state.address.address + ', ' + state.address.city + ', ' + state.address.state + ' ' + state.address.zipcode;
  const warehouseAddress = '1355 Market St #900, San Francisco, CA 94103';

  instance
  .location()
  .then(function(data) {
    return 'home'; //initMap(warehouseAddress, homeAddress, data[Object.keys(data)[0]]);
  }).then(function(deliveryLocation) {
    console.log(deliveryLocation);
    return res.render('delivery', { deliveryLocation })
  }).catch(function(err) {
    const message = err.message || 'Failed to get vehicle location.';
    const action = 'fetching vehicle location';
    return redirectToError(res, message, action);
  });
});

app.listen(PORT, function() {
  console.log(`smartcar-demo server listening on port ${PORT}`);
  opn(`http://localhost:${PORT}`);
});

function initMap(warehouse, destinationHouse) {
  //Implement how to grab the addresses and turn regular addresses into coorinates
  var destinationCar = new google.maps.LatLng(37.788759, -122.411561); //37.788759, -122.411561 HackBright Car

  var service = new google.maps.DistanceMatrixService();
  service.getDistanceMatrix(
    {
      origins: [warehouse],
      destinations: [destinationCar, destinationHouse],
      travelMode: 'DRIVING',
      //transitOptions: TransitOptions,
      //drivingOptions: DrivingOptions,
      unitSystem: google.maps.UnitSystem.METRIC,
      avoidHighways: false,
      avoidTolls: false
    },
    callback
  );

  function callback(response, status) {
    let shortDist = 10000000;
    let o;
    let d;

    if (status == 'OK') {
      var origins = response.originAddresses;
      var destinations = response.destinationAddresses;

      for (var i = 0; i < origins.length; i++) {
        var results = response.rows[i].elements;

        for (var j = 0; j < results.length; j++) {
          if (results[j].distance.value < shortDist) {
            shortDist = results[j].distance.value;
            o = origins[i];
            d = destinations[j];
          }

          var element = results[j];
          var distance = element.distance.text;
          var duration = element.duration.text;
          var from = origins[i];
          var to = destinations[j];

          console.log(
            from + ' to ' + to + ': ' + distance + ' in ' + duration + '<br>'
          );
        }
      }
      console.log(
        'Shortest distance is: ' +
          shortDist +
          ' from ' +
          o +
          ' to ' +
          d +
          '<br>'
      ); //found which is faster

      if (d == destinations[0]) return 'car';
      //RETURN WHATEVER INSTEAD
      else return 'house';
    } //Find out how to return
  }
}
