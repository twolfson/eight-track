// Load in our dependencies
var pem = require('pem');
var https = require('https');
var request = require('request');

// Allow self sign certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Generate a certificate
pem.createCertificate({days: 1, selfSigned: true}, function handleCertificate (err, keys) {
  // If there is an error, throw it
  if (err) {
    throw err;
  }

  // keys = {csr, clientKey, certificate, serviceKey}

  // Generate a public key for our certificate
  // TODO: It looks like the callback is using `err`
  pem.getPublicKey(keys.certificate, function handlePublicKey (err, publicCertObj) {
    // If there is an error, throw it
    if (err) {
      throw err;
    }

    // publicCertObj = {publicKey}

    // Start an HTTPS server using our certificate
    var server = https.createServer({
      key: keys.serviceKey,
      cert: keys.certificate,
      requestCert: true,
      rejectUnauthorized: true
    }, function handleRequest (req, res) {
      res.end('hello');
    });
    server.listen(3000);

    // Send a request to our server
    request({
      agentOptions: {
        cert: keys.certificate,
        key: keys.clientKey
      },
      url: 'https://localhost:3000/'
    }, function handleResponse (err, res, body) {
      // If there is an error, throw it
      if (err) {
        throw err;
      }

      // Log our body
      console.log(body);
      process.exit();
    });
  });
});
