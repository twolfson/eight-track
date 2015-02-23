// Load in our dependencies
var pem = require('pem');
var https = require('https');
var request = require('request');

// Generate a certificate
pem.createCertificate({days: 1, selfSigned: true}, function handleCertificate (err, keys) [
  // TODO: It looks like the callback is using `err`
  pem.getPublicKey(x509.cert, function handlePublicKey (err, publicCert) {

  });
});
