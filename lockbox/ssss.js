goog.provide('ssss');

goog.require('comb');
goog.require('gf28');
goog.require('goog.array');
goog.require('goog.functions');
goog.require('rng');


/**
 * Uses Shamir's Secret Sharing scheme to split a message into n distinct
 * keys.
 *
 * @param {string|ArrayBuffer|Array.<number>} msg Message to split -- either a
 *     string, an ArrayBuffer, or an array of bytes.
 * @param {number} k Minimum number of keys needed to recombine msg.
 * @param {number=} opt_n Total number of keys to produce (if unspecified,
 *     n=k).
 * @param {rng.Rng=} opt_gen Entropy source for the algorithm (if
 *     unspecified, use Math.random).
 * @return {Array.<ssss.Key>} n keys of which any k can reconstruct msg, for
 *     which any k - 1 or fewer are indistinguishable from random.
 */
ssss.split = function(msg, k, opt_n, opt_gen) {
  var n = (typeof opt_n == 'undefined') ? k : opt_n;
  var gen = (typeof opt_gen == 'undefined') ? rng.getRng() : opt_gen;

  if (k < 2) throw new Error('Threshold must be at least 2.');
  if (n < k) throw new Error('Must have at least threshold total keys.');
  if (n > gf28.MASK) throw new Error("Can't make more than " + gf28.MASK +
                                     " distinct keys.");

  var m, view;
  if (msg instanceof ArrayBuffer) {
    view = new Uint8Array(msg);
    m = view.length;
  } else {
    m = msg.length;
    view = new Uint8Array(m);
    var ptFn = typeof msg == 'string'
        ? function(i) { return msg.charCodeAt(i); }
        : function(i) { return msg[i]; };
    for (var i = 0; i < m; ++i) {
      var b = ptFn(i);
      if (!gf28.isElem(b)) throw new Error(b + ' at msg[' + i +
                                           '] is out of range.');
      view[i] = b;
    }
  }

  var cs = new Uint8Array(k);
  var ret = new Array(n);

  var polyAt = function(x) {
    var sum = gf28.ZERO;
    var pow = gf28.ONE;
    for (var j = 0; j < cs.length; ++j) {
      var term = gf28.mul(cs[j], pow);
      pow = gf28.mul(pow, x);
      sum = gf28.add(sum, term);
    }
    return sum;
  }

  for (var i = 0; i < n; ++i) {
    ret[i] = new Uint8Array(1 + m);
    ret[i][0] = i + 1;
  }

  for (var i = 0; i < m; ++i) {
    gen['getRandomValues'](cs.subarray(1));
    cs[0] = view[i];
    for (var j = 0; j < n; ++j) {
      ret[j][1 + i] = polyAt(j + 1);
    }
  }

  return ret;
}

/**
 * Recombines k or more keys produced by ssss.split back into the original
 * secret message. If fewer than k keys are given, the result will be random.
 * No checksums are embedded; clients are responsible for constructing their
 * own verification mechanism, e.g. signing the message prior to encryption.
 *
 * @param {Array.<ssss.Key>} keys Array of keys to recombine.
 * @param {number=} opt_k Optional threshold value; if passed, only
 *     combinations of up to opt_k keys will be tried.
 * @param {function(Uint8Array): boolean=} opt_pred Optional predicate function
 *     used to validate keys. If passed, then the returned result must have
 *     opt_pred(result) == true. Different combinations of keys will be tried
 *     until one is found; if none exists, then this will throw an error.
 * @return {Uint8Array} The decoded message.
 */
ssss.combine = function(keys, opt_k, opt_pred) {
  var k = (typeof opt_k == 'undefined') ? keys.length : opt_k;
  var pred = (typeof opt_pred == 'undefined') ? goog.functions.TRUE
                                              : opt_pred;
  if (k > keys.length) {
    k = keys.length;
  }
  if (k != keys.length) {
    var c = /** @type {Array.<ssss.Key>} */ comb.combinationSuchThat(
        goog.functions.compose(pred, ssss.combine), keys, k);
    return (c == null) ? null : ssss.combine(c);
  }
  if (keys.length == 0) throw new Error("Can't combine nothing.");
  if (!goog.array.every(keys, function(key) {
        return key.length == keys[0].length;
      })) {
    throw new Error('Unequal key lengths.');
  }
  var m = keys[0].length - 1;
  var ret = new Uint8Array(m);
  var pts = new Array(k);

  for (var i = 0; i < m; ++i) {
    for (var j = 0; j < k; ++j) {
      pts[j] = {'x': keys[j][0], 'y': keys[j][i + 1]};
    }
    ret[i] = ssss.combinePt_(pts);
  }
  return ret;
}

/**
 * @param {Array.<{x: gf28.elem, y: gf28.elem}>} pts Points to combine.
 * @return {gf28.elem} Interpolated polynomial evaluated at x == 0.
 * @private
 */
ssss.combinePt_ = function(pts) {
  // We use LaGrange interpolation to determine p(x) and evaluate it at 0 to
  // retrieve the original byte.  The LaGrange polynomial over the points
  // ((x_0, y_0), ..., (x_n, y_n)) is
  //   p(x) = y_0 l_0(x) + ... + y_n l_n(x)
  // where
  //   l_i(x) = \product_{j!=i} (x - x_j)/(x_i - x_j).

  var sum = gf28.ZERO;
  var x = gf28.ZERO;

  for (var i = 0; i < pts.length; ++i) {
    var xi = pts[i]['x'];
    var prod = gf28.ONE;
    for (var j = 0; j < pts.length; ++j) {
      if (i == j) continue;
      var xj = pts[j]['x'];
      if (xi == xj) throw new Error('Keys at ' + i + ' and ' + j +
                                    ' have the same x-coordinates.');
      prod = gf28.mul(prod, gf28.div(gf28.sub(x, xj), gf28.sub(xi, xj)));
    }
    sum = gf28.add(sum, gf28.mul(pts[i]['y'], prod));
  }
  return sum;
}

/**
 * @typedef {Uint8Array}
 */
ssss.Key = {};

/**
 * @param {ssss.Key} key
 * @return {gf28.elem} x-coord of points encoded by key
 */
ssss.Key.getX = function(key) {
  var k = new Uint8Array(key);
  return k[0];
}

/**
 * @param {ssss.Key} key
 * @param {number} idx
 * @return {gf28.elem} y-coord of point at idx in key
 */
ssss.Key.getY = function(key, idx) {
  var k = new Uint8Array(key);
  return k[idx + 1];
}

goog.exportSymbol('ssss.combine', ssss.combine);
goog.exportSymbol('ssss.split', ssss.split);
goog.exportSymbol('ssss.Key.getX', ssss.Key.getX);
goog.exportSymbol('ssss.Key.getY', ssss.Key.getY);
