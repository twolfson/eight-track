var expect = require('chai').expect;
var httpUtils = require('./utils/http');
var serverUtils = require('./utils/server');

describe('A `nine-track` server proxying an HTTPS server needing a client cert', function () {
  serverUtils.runHttps(1337, function (req, res) {
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
    });
  });
});
