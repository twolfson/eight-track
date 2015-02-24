var expect = require('chai').expect;
var certy = require('certy');
var httpUtils = require('./utils/http');
var serverUtils = require('./utils/server');

describe('An `nine-track` server proxying an HTTPS server', function (done) {
  this.timeout(9000);
  certy.create(function saveCertificate (err, certs) {
    var options = {requestCert: false, rejectUnauthorized: false};
    serverUtils.runHttps(1337, certs, options, function (req, res) {
      res.send('oh hai');
    });
    serverUtils.runNineServer(1338, {
      fixtureDir: __dirname + '/actual-files/redirect',
      url: 'https://localhost:1337/'
    });

    describe('when requested', function () {
      before(function allowSelfSignedCert () {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      });
      httpUtils.save('http://localhost:1338/');

      it('proxies to the server', function () {
        expect(this.err).to.equal(null);
        expect(this.res.statusCode).to.equal(200);
        expect(this.body).to.equal('oh hai');
        done(err);
      });
    });
  });
});

describe('An `nine-track` server proxying an HTTPS server with cert', function (done) {
  this.timeout(9000);
  certy.create(function saveCertificate (err, certs) {
    var options = {requestCert: true, rejectUnauthorized: true};
    serverUtils.runHttps(1337, certs, options, function (req, res) {
      res.send('oh hai');
    });
    serverUtils.runNineServer(1338, {
      fixtureDir: __dirname + '/actual-files/https',
      url: 'https://localhost:1337/',
      agentOptions: {
        cert: certs.clientCrt,
        key: certs.clientKey
      }
    });

    describe('when requested', function () {
      before(function allowSelfSignedCert () {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      });
      httpUtils.save('http://localhost:1338/');

      it('proxies to the server', function () {
        expect(this.err).to.equal(null);
        expect(this.res.statusCode).to.equal(200);
        expect(this.body).to.equal('oh hai');
        done(err);
      });
    });
  });
});
