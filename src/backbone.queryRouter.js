'use strict';
// Is there a better way to pick up window globals?
var Backbone = (window && window.Backbone) || require('backbone');
var _ = (window && window._) || require('underscore');
var querystring = require('qs');
var diff = require('deep-diff');

/**
 * Backbone.History overrides.
 * @type {Backbone.History}
 */
var QueryHistory = Backbone.History.extend( /** @lends QueryHistory# **/{

  /**
   * Override history constructor to init some properties and set the embedded query 
   * model listener.
   * @constructs
   * @type {Backbone.History}
   */
  constructor: function() {
    this.previousQuery = {};
    this.queryHandlers = [];
    this.listenTo(this.query, 'change', this.onQueryModelChange);
    Backbone.History.call(this);
  },

  /**
   * Extracts querystrings from routes.
   * @type {RegExp}
   */
  queryMatcher: /^([^?]*?)(?:\?([\s\S]*))?$/,

  /**
   * Model emcompassing current query state. You can read and set properties
   * on this Model and `Backbone.history.navigate()` will automatically be called.
   * @type {Backbone.Model}
   */
  query: new Backbone.Model(),

  /**
   * Parse a fragment into a query object and call handlers matching.
   * @param {String} fragment Route fragment.
   * @param {Object} options Navigation options.
   */
  loadQuery: function(fragment, options) {
    var query = this._fragmentToQueryObject(fragment);
    var previous = this.previousQuery;

    // Save previous query.
    this.previousQuery = query;

    // Diff new and old queries.
    var diffs = this._getDiffs(previous, query);
    if (!diffs.length) return;

    // Set embedded model to new query object, firing 'change' events.
    this.stopListening(this.query, 'change', this.onQueryModelChange);
    this.query.set(query);
    this.listenTo(this.query, 'change', this.onQueryModelChange);

    // Call each function that subscribes to these items.
    // This is intentional, rather than fire events on each changed item;
    // this way, you don't have to debounce your handlers since they are only called once,
    // even if multiple query items change.
    _.each(this.queryHandlers, function(handler) {
      var intersections = _.intersection(diffs, handler.bindings);
      if (intersections.length) {
        handler.callback(fragment, _.pick(query, intersections));
      }
    });
  },

  /**
   * Override loadUrl & watch return value. Trigger event if no route was matched.
   * @return {Boolean} True if a route was matched.
   */
  loadUrl: function() {
    var matched = Backbone.History.prototype.loadUrl.apply(this, arguments);
    if (!matched) {
      this.trigger('routeNotFound', arguments);
    }
    return matched;
  },

  /**
   * Add loadQuery hook.
   *
   * @param {String} fragment History fragment.
   * @param {Object} options  Navigation options.
   */
  navigate: function(fragment, options) {
    if (!Backbone.History.started) return false;
    if (!options) options = {};

    // Fire querystring routes.
    if (options.trigger) {
      this.loadQuery(fragment, options);
    }

    // Call navigate on prototype since we just overrode it.
    Backbone.History.prototype.navigate.call(this, fragment, options);
  },

  /**
   * When the query model changes, run all associated routes.
   * @param  {Model}  model   Attached model.
   * @param  {Object} options Change options.
   */
  onQueryModelChange: function(model, options) {
    var fragment = this.fragment || '';
    var oldQS = querystring.stringify(this.previousQuery);
    var newQS = querystring.stringify(model.toJSON());
    this.navigate(fragment.replace(oldQS, newQS), {trigger: true});
  },

  /**
   * Add a query to be tested when the fragment changes.
   * @param  {Array}   bindings  Query keys to listen to.
   * @param  {Function} callback Callback to call when these keys change.
   */
  queryHandler: function(bindings, callback) {
    this.queryHandlers.push({bindings: bindings, callback: callback});
  },

  /**
   * Given two objects, compute their differences and list them.
   * When diffing deep objects, return one string for the object and one for each child.
   * This allows functions to bind to deep properties or its parent.
   * E.g. a change to a.b.c returns ['a', 'a.b', 'a.b.c']
   *
   * This uses DeepDiff (flitbit/diff), which can detect changes deep within objects.
   * We don't use objects in querystrings quite yet, but we do arrays. And that might change.
   *
   * @example
   *   _getDiffs({q: 'foo', deep: {object: 'blah'}}, {q: 'bar', fq: 'foo', deep: {object: 'blah2'}})
   *     -> ['q', 'fq', 'deep', 'deep.object']
   *
   * @param  {Object} lhs Left hand object.
   * @param  {Object} rhs Right hand (new) object.
   * @return {Array}      Array of string differences.
   */
  _getDiffs: function(lhs, rhs) {
    var diffs = diff(lhs, rhs);
    var diffKeys = _.reduce(diffs, function(result, diff) {
      var paths = _.map(diff.path, function(path, i) {
        return _.first(diff.path, i + 1).join('.');
      });
      return result.concat(paths);
    }, []);
    return _.uniq(diffKeys);
  },

  /**
   * Given a fragment, return a query object.
   * @param  {String} fragment Route fragment.
   * @return {Object}          Query object.
   */
  _fragmentToQueryObject: function(fragment) {
    return querystring.parse(this._fragmentToQueryString(fragment));
  },

  /**
   * Given a fragment, return a query string.
   * @param  {String} fragment Route fragment.
   * @return {String}          Query string.
   */
  _fragmentToQueryString: function(fragment) {
    if (!fragment) return '';
    var match = fragment.match(this.queryMatcher);
    return match[2] || '';
  }
});

var RouterProto = Backbone.Router.prototype;
/**
 * Backbone.Router overrides.
 * @type {Backbone.Router}
 */
var QueryRouter = Backbone.Router.extend(/** @lends QueryRouter# */{
  /**
   * Bind query routes.
   * 
   * Remember that handlers will only fire once per navigation. If for some reason you'd like
   * a handler to fire for each individual change, bind to the 'change:{key}' events on 
   * Backbone.history.query, which is just a Backbone.Model (and fires all of the usual
   * events).
   *
   * They are expected to be attached in the following configuration:
   * 
   * ```javascript
   * queryRoutes: [
   *   'key1,key2,key3': 'handlerName',
   *   'q, sort, rows': function() { // ... },
   *   'nested.object': 'deepHandler'
   * ]
   * ```
   */
  _bindRoutes: function() {
    if (!this.queryRoutes) return;
    this.queryRoutes = _.result(this, 'queryRoutes');
    var qRoute, qRoutes = _.keys(this.queryRoutes);
    while ((qRoute = qRoutes.pop()) != null) {
      this.queryHandler(qRoute, this.queryRoutes[qRoute]);
    }
    RouterProto._bindRoutes.apply(this, arguments);
  },

  /**
   * Bind a queryHandler. Very similar to Backbone.Router#route, except that args
   * are provided by Backbone.history#queryHandler, rather than being extracted
   * in the router from the fragment.
   * @param  {String|array}  bindings Query key bindings.
   * @param  {String}   [name]        Listener name.
   * @param  {Function} callback      Listener callback.
   */
  queryHandler: function(bindings, name, callback) {
    bindings = this._normalizeBindings(bindings);
    if (_.isFunction(name)) {
      callback = name;
      name = '';
    }
    if (!callback) callback = this[name];
    var router = this;
    Backbone.history.queryHandler(bindings, function(fragment, args) {
      router.execute(callback, [args]);
      router.trigger.apply(router, ['route:' + name].concat(args));
      router.trigger('route', name, args);
      Backbone.history.trigger('route', router, name, args);
    });
    return this;
  },

  /**
   * Normalize bindings - convert to array and trim whitespace.
   * @param  {String} bindings Bindings definition.
   * @return {Array}           Normalized bindings.
   */
  _normalizeBindings: function(bindings) {
    if (_.isString(bindings)) {
      bindings = bindings.split(',');
    }
    return _.invoke(bindings, 'trim');
  }
});

// Override default Backbone.Router constructor.
Backbone.Router = QueryRouter;

// Replace Backbone.history.
Backbone.history = new QueryHistory();
