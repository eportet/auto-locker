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

//Google Maps API

var googleMapsClient = require('@google/maps').createClient({
  key: 'AIzaSyAnC8jPdJ8TBmCe2XjFtJ_pVwHB826r2YU',
  Promise: Promise
});

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
    .then(({ data }) => {

      googleMapsClient
        .distanceMatrix({
          origins: [warehouseAddress],
          destinations: [homeAddress, data.latitude + ',' + data.longitude ]
        })
        .asPromise()
        .then(response => {
          data.destinationHome = response.json.rows[0].elements[0];
          data.destinationCar = response.json.rows[0].elements[1];
          console.log(data);
          let deliveryLocation = '';
          if (data.destinationHome.duration.value > data.destinationCar.duration.value) {
            deliveryLocation = 'car';
          } else {
            deliveryLocation = 'home';
          }
          return res.render('delivery', { deliveryLocation });
        })
        .catch(err => {
          console.log(err);
        });
    })
    .catch(function(err) {
      const message = err.message || 'Failed to get vehicle location.';
      const action = 'fetching vehicle location';
      return redirectToError(res, message, action);
    });
});

app.get('/driver', function(req, res) {
  res.render('driver');
});

app.post('/unlock', function(req, res){
  const instance = new smartcar.Vehicle(
    state.vehicle.id,
    state.access.accessToken
  );

  instance.unlock()
  .catch(function(err) {
    const message = err.message || 'Failed to send unlock request to vehicle.';
    const action = 'unlocking vehicle';
    return redirectToError(res, message, action);
  });
  res.redirect('/driver');
});

app.post('/lock', function(req, res) {
  const instance = new smartcar.Vehicle(
    state.vehicle.id,
    state.access.accessToken
  );

  instance.lock()
  .catch(function(err) {
    const message = err.message || 'Failed to send lock request to vehicle.';
    const action = 'locking vehicle';
    return redirectToError(res, message, action);
  });
  res.redirect('/driver');
});

app.listen(PORT, function() {
  console.log(`smartcar-demo server listening on port ${PORT}`);
  opn(`http://localhost:${PORT}`);
});
