var assert = require('assert');
var crypto = require('crypto');
var url = require('url');
var _ = require('underscore');
var async = require('async');
var Store = require('fs-memory-store');
var request = require('request');
var Message = require('./message');

// Define glob escape helper
// TODO: Break out as another module
function escapeGlob(pattern) {
  // https://github.com/isaacs/node-glob/tree/v5.0.5#glob-primer
  return pattern.replace(/\*\?\[\]^\+\*@/g, '\\$&');
}

function NineTrack(options) {
  // Assert we received the expected options
  assert(options.url, '`nine-track` expected `options.url` but did not receive it');
  assert(options.fixtureDir, '`nine-track` expected `options.fixtureDir` but did not receive it');

  // Pre-emptively parse options
  var remoteUrl = options.url;
  if (typeof remoteUrl === 'string') {
    remoteUrl = url.parse(remoteUrl);
  }

  // Save remoteUrl and fixtureDir for later
  this.preventRecording = options.preventRecording;
  this.remoteUrl = remoteUrl;
  this.normalizeFn = options.normalizeFn;
  this.scrubFn = options.scrubFn;
  this.store = new Store(options.fixtureDir);
}
NineTrack.placeholderRequest = 'Parallel request. Unable to determine hash.';
NineTrack.prototype = {
  startSeries: function (seriesKey) {
    assert.strictEqual(this.seriesKey, undefined, '`nineTrack.startSeries` has already been invoked. ' +
      'Please call `nineTrack.stopSeries` before starting a new one.');
    assert(seriesKey, '`nineTrack.startSeries` requires `seriesKey` to be defined. Please define it.');
    this.seriesKey = seriesKey;
    this.pastRequestKeys = [];
    this.isNewRecording = false;
  },
  stopSeries: function () {
    delete this.seriesKey;
    delete this.pastRequestKeys;
    delete this.isNewRecording;
  },

  getConnectionKey: function (reqMsg) {
    // Generate an object representing the request
    var info = reqMsg.getRequestInfo();

    // Pass through scrubber to prevent excess info getting into hash
    if (this.scrubFn) {
      var _info = this.scrubFn({request: info});
      if (_info) {
        info = _info.request;
      }
    }

    // Normalize the info
    if (this.normalizeFn) {
      info = this.normalizeFn(info) || info;
    }

    // Stringify the info and hash it
    if (info.body && Buffer.isBuffer(info.body)) {
      info.body = info.body.toString('base64');
    }
    var json = JSON.stringify(info);
    var md5 = crypto.createHash('md5');

    // If we are in a series, add on past keys to our hash
    if (this.seriesKey) {
      json += this.seriesKey + '=' + reqMsg.pastRequestKeys.join(';');
    }

    // Finish our hash
    md5.update(json);
    var hash = md5.digest('hex');

    // Compound method, url, and hash to generate the key
    // DEV: We truncate URL at 32 characters to prevent ENAMETOOLONG
    // https://github.com/uber/eight-track/issues/7
    var url = encodeURIComponent(info.url).substr(0, 32);
    var retVal = info.method + '_' + url + '_' + hash;

    // If we have a series key, add it on to the pathname
    if (this.seriesKey) {
      retVal = this.seriesKey + '_' + retVal;
    }

    // Return our key
    return retVal;
  },

  _serializeBody: function (obj) {
    // Serialize the buffer for disk
    var _buff = obj.body;
    var bodyEncoding = 'utf8';
    var body = _buff.toString(bodyEncoding);

    // If the buffer is not utf8-friendly, serialize it to base64
    var testBuffer = new Buffer(body, bodyEncoding);
    if (testBuffer.length !== _buff.length) {
      bodyEncoding = 'base64';
      body = _buff.toString(bodyEncoding);
    }

    // Save the new body
    var retObj = _.omit(obj, 'body');
    retObj.bodyEncoding = bodyEncoding;
    retObj.body = body;

    // Return our object ready for serialization
    return retObj;
  },
  getConnection: function (key, cb) {
    this.store.get(key, function handleGet (err, info) {
      // If there was an error, callback with it
      if (err) {
        return cb(err);
      // Otherwise, if there was no info, callback with it
      } else if (!info) {
        return cb(err, info);
      }

      // Otherwise, de-serialize the buffer
      var _body = info.response.body;
      info.response.body = _body.length ? new Buffer(_body, info.response.bodyEncoding || 'utf8') : '';
      cb(null, info);
    });
  },
  saveConnection: function (key, _info, cb) {
    // Serialize our information
    // DEV: `pastRequestKeys` should be supplied already on info
    var info = _.clone(_info);
    info.request = this._serializeBody(info.request);
    info.response = this._serializeBody(info.response);

    // Save our serialized info
    this.store.set(key, info, cb);
  },

  createRemoteRequest: function (localReqMsg) {
    // Prepate the URL for headers logic
    // TODO: It feels like URL extension deserves to be its own node module
    // http://nodejs.org/api/url.html#url_url
    /*
      headers: local (+ remote host)
      protocol: remote,
      hostname: remote,
      port: remote,
      pathname: remote + local, (e.g. /abc + /def -> /abc/def)
      query: local
    */
    var localReq = localReqMsg.connection;
    var localUrl = url.parse(localReq.url);
    var _url = _.pick(this.remoteUrl, 'protocol', 'hostname', 'port');

    // If the remotePathname is a `/`, convert it to a ''.
    //   Node decides that all URLs deserve a `pathname` even when not provided
    var remotePathname = this.remoteUrl.pathname || '';
    if (remotePathname === '/') {
      remotePathname = '';
    }

    // DEV: We use string concatenation because we cannot predict how all servers are designed
    _url.pathname = remotePathname + (localUrl.pathname || '');
    _url.search = localUrl.query;

    // Set up headers
    var headers = localReq.headers;

    // If there is a host, use our new host for the request
    if (headers.host) {
      headers = _.clone(headers);
      delete headers.host;

      // Logic taken from https://github.com/mikeal/request/blob/v2.30.1/request.js#L193-L202
      headers.host = _url.hostname;
      if (_url.port) {
        if (!(_url.port === 80 && _url.protocol === 'http:') &&
            !(_url.port === 443 && _url.protocol === 'https:')) {
          headers.host += ':' + _url.port;
        }
      }
    }

    // Forward the original request to the new server
    var remoteReq = request({
      // DEV: Missing `httpVersion`
      headers: headers,
      // DEV: request does not support `trailers`
      trailers: localReq.trailers,
      method: localReq.method,
      url: url.format(_url),
      body: localReqMsg.body,
      // DEV: This is probably an indication that we should no longer use `request`. See #19.
      followRedirect: false
    });
    return remoteReq;
  },

  forwardRequest: function (localReq, callback) {
    // Create a connection to pass around between methods
    // DEV: This cannot be placed inside the waterfall since in 0.8, we miss data + end events
    var localReqMsg = new Message(localReq);
    var requestKey, remoteResMsg, connInfo;

    // Grab a copy of the current set of request keys immediately to prevent race conditions
    // DEV: This is a regression fix for https://github.com/twolfson/nine-track/issues/8
    var pastRequestIndex;
    if (this.seriesKey) {
      localReqMsg.pastRequestKeys = this.pastRequestKeys.slice();
      pastRequestIndex = this.pastRequestKeys.length;
      this.pastRequestKeys[pastRequestIndex] = NineTrack.placeholderRequest;
    }

    function sendConnInfo(connInfo) {
      return callback(null, connInfo.response, connInfo.response.body);
    }

    // Create marker for request loading before we get to `loadIncomingBody` listener
    var localReqLoaded = false;
    localReqMsg.on('loaded', function updateLoadedState () {
      localReqLoaded = true;
    });

    var that = this;
    async.waterfall([
      function loadIncomingBody (cb) {
        if (localReqLoaded) {
          return process.nextTick(cb);
        }
        localReqMsg.on('loaded', cb);
      },
      function findSavedConnection (cb) {
        requestKey = that.getConnectionKey(localReqMsg);
        if (that.seriesKey) {
          that.pastRequestKeys[pastRequestIndex] = requestKey;
        }
        that.getConnection(requestKey, cb);
      },
      function createRemoteReq (connInfo, cb) {
        // If we successfully found the info, reply with it
        if (connInfo) {
          return sendConnInfo(connInfo);
        }

        // If we are not support to make/record future requests, bail out
        if (that.preventRecording) {
          var serializedReq = localReqMsg.getRequestInfo();
          return cb(new Error('Fixture not found for request "' + JSON.stringify(serializedReq) + '"'));
        }

        // If we are inside of a series
        // DEV: Reminder: We are inside of a new request being made since `connInfo` would exist otherwise
        if (that.seriesKey) {
          // If this is the first request, mark it as a new recording
          var nonPlaceholderRequestKeys = localReqMsg.pastRequestKeys.filter(function fitlerOutPlaceholders (msg) {
            return msg !== NineTrack.placeholderRequest;
          });
          if (nonPlaceholderRequestKeys.length < 1) {
            that.isNewRecording = true;
          // Otherwise, if this is not a new recording, consider our series corrupted
          //   Determine the source and clean everything up
          } else if (that.isNewRecording !== true) {
            // Resolve our series based fixtures
            // TODO: Relocate all of this to a method
            function loadFixtures(keys, callback) {
              async.map(keys, function loadFixture (key, callback2) {
                that.store.get(key, callback2);
              }, function handleLoadedFixture (err, fixtures) {
                // If there was an error, callback with it
                if (err) {
                  return callback(err);
                }

                // Otherwise, save the key onto the fixtures
                // TODO: Should we save the key inside of the fixtures?
                fixtures.forEach(function saveKey (fixture, i) {
                  fixture.key = keys[i];
                });
                callback(null, fixtures);
              });
            }
            function loadSeriesFixtures(callback) {
              // TODO: Maybe use a `/` for series? People might use snake_case in naming and we don't want an accidental match
              that.store.keys(escapeGlob(that.seriesKey + '_*'), function handleFixtures (err, keys) {
                // If there was an error, callback with it
                if (err) {
                  return callback(err);
                }

                // Otherwise, load each of our fixtures
                loadFixtures(keys, callback);
              });
            }
            return loadSeriesFixtures(function handleFixtures (err, fixtures) {
              // If there was an error, callback with it
              // TODO: Provide some kind of message about how we are cleaning up
              if (err) {
                // TODO: Still clean up fixtures
                return cb(err);
              }

              // Find matching or taller fixtures stacks
              //   e.g. stopped at `['abcdef']`, match `['abcdef']` and `['abcdef', 'ghijkl']` but not `[]`
              var matchingFixtures = fixtures.filter(function filterTallerFixture (fixture) {
                var i = 0;
                var expectedPastRequestkeys = localReqMsg.pastRequestKeys;
                var len = expectedPastRequestkeys.length;
                for (; i < len; i++) {
                  if (fixture.pastRequestKeys[i] !== expectedPastRequestkeys[i]) {
                    return false;
                  }
                }
                return true;
              });

              // If there are no matching fixtures, bail
              // TODO: Figure out better message
              if (matchingFixtures.length === 0) {
                // TODO: Still clean up fixtures
                return cb(new Error('While cleaning up nine-track fixtures, couldn\'t find matching fixtures to compare to'));
              }

              // Find the tallest of our fixtures for the most info
              var tallestMatchingFixture = matchingFixtures[0];
              matchingFixtures.forEach(function findTallerFixture (fixture) {
                if (fixture.pastRequestKeys.length > tallestMatchingFixture.pastRequestKeys.length) {
                  tallestMatchingFixture = fixture;
                }
              });

              // TODO: Load the past requests used for each of the past request keys
              //   in both the active request and the tallest matching fixture
              // TODO: Run a JSON diff on them and output it
              console.log('hi', tallestMatchingFixture);
              // TODO: We can prob keep `localReqMsg's` items in memory. But maybe that's not practical since we only do this on failure
              async.parallel([
                function loadActivePastRequests (callback) {
                  loadFixtures(localReqMsg.pastRequestKeys, callback);
                },
                function loadSavedPastRequest (callback) {
                  loadFixtures(tallestMatchingFixture.pastRequestKeys, callback);
                }
              ], function handlePastRequests (err, results) {
                // If there was an error, bail
                // TODO: Figure out better message
                if (matchingFixtures.length === 0) {
                  // TODO: Still clean up fixtures
                  return cb(new Error('While loading past requests to get a better error message'));
                }

                // Add on our localReqMsg for viewing
                var activeRequests = results[0];
                // TODO: Add on series key and past requests keys as we do elsewhere
                activeRequests.push({request: localReqMsg.getRequestInfo()});
                var savedRequests = results[1];
                // TODO: Maybe perform extension in parallel?
                savedRequests.push(tallestMatchingFixture);

                // TODO: Perform JSON diff?
                console.error('Active requests:', activeRequests);
                console.error('Saved requests:', savedRequests);

                // TODO: Delete all series fixtures
                // Prepare our message
                var msg = '`nineTrack` found a corrupted series while playing back HTTP fixtures. ' +
                  'To resolve this, we have removed the fixtures from the start of this series. ' +
                  'Unfortunately, we must raise an error and require you to re-run your test suite. ' +
                  'Otherwise, your database and tests would be in an inconsistent state between this and future runs.';

                // If there was an error, log our message and callback with the error
                if (err) {
                  console.error(msg);
                  cb(err);
                // Otherwise, callback with the message as an error
                } else {
                  cb(new Error(msg));
                }
              });
            });
          }
        }

        // Forward the original request to the new server
        var remoteReq = that.createRemoteRequest(localReqMsg);

        // When we receive a response, load the response body
        remoteReq.on('error', cb);
        remoteReq.on('response', function handleRes (remoteRes) {
          remoteResMsg = new Message(remoteRes);
          remoteResMsg.on('loaded', cb);
        });
      },
      function saveIncomingRemote (cb) {
        // Save the incoming request and remote response info
        connInfo = {
          request: localReqMsg.getRequestInfo(),
          response: remoteResMsg.getResponseInfo()
        };

        if (that.seriesKey !== undefined) {
          connInfo.seriesKey = that.seriesKey;
          connInfo.pastRequestKeys = localReqMsg.pastRequestKeys;
        }

        // If there is a scrubber, pass it through
        if (that.scrubFn) {
          var lastLen = connInfo.response.body.length;
          connInfo = that.scrubFn(connInfo) || connInfo;

          // If the body has changed in length, fix the content-length
          if (connInfo.response.body && connInfo.response.body.length !== lastLen) {
            connInfo.response.headers['content-length'] = connInfo.response.body.length.toString();
          }
        }

        that.saveConnection(requestKey, connInfo, cb);
      }
    ], function handleResponseInfo (err) {
      if (err) {
        return callback(err);
      } else {
        return sendConnInfo(connInfo);
      }
    });
  },

  handleConnection: function (localReq, localRes) {
    // DEV: remoteRes is not request's response but an internal response format
    this.forwardRequest(localReq, function handleForwardedResponse (err, remoteRes, remoteBody) {
      // If there was an error, emit it
      if (err) {
        err.req = localReq;
        err.res = localRes;
        localReq.emit('error', err);
        localRes.end();
      // Otherwise, send the response
      } else {
        localRes.writeHead(remoteRes.statusCode, remoteRes.headers);
        localRes.write(remoteBody);
        localRes.end();
      }
    });
  },

  removeFixtures: function (keys, callback) {
    var that = this;
    async.forEach(keys, function deleteFixture (key, cb) {
      that.store['delete'](key, cb);
    }, callback);
  }
};

function middlewareCreator(options) {
  // Create a new nine track for our middleware
  var nineTrack = new NineTrack(options);

  // Define a middleware to handle requests `(req, res)`
  function nineTrackMiddleware(localReq, localRes) {
    nineTrack.handleConnection(localReq, localRes);
  }

  // Add on prototype methods (e.g. `forwardRequest`)
  var keys = Object.getOwnPropertyNames(NineTrack.prototype);
  keys.forEach(function bindNineTrackMethod (key) {
    nineTrackMiddleware[key] = function executeNineTrackMethod () {
      nineTrack[key].apply(nineTrack, arguments);
    };
  });

  // Return the middleware
  return nineTrackMiddleware;
}

// Expose class on top of middlewareCreator
middlewareCreator.NineTrack = NineTrack;
middlewareCreator.Message = Message;

// Expose our middleware constructor
module.exports = middlewareCreator;
