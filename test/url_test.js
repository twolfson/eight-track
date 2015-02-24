var expect = require('chai').expect;
var httpUtils = require('./utils/http');
var serverUtils = require('./utils/server');

describe('An `nine-track` server proxying a subpath', function () {
  serverUtils.run(1337, function (req, res) {
    res.send(req.url);
  });
  serverUtils.runNineServer(1338, {
    fixtureDir: __dirname + '/actual-files/redirect',
    url: 'http://localhost:1337/hello'
  });

  describe('when requested with a path', function () {
    httpUtils.save('http://localhost:1338/world');

    it('concatenates the path', function () {
      expect(this.err).to.equal(null);
      expect(this.body).to.equal('/hello/world');
    });
  });
});
