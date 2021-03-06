'use strict';

var Browser = require('zombie');
var urlParser = require('url');
var LRU = require("lru-cache");
var async = require('async');

exports = module.exports = function(options) {
  // regex for stripping html of script tags. Borrowed from jQuery
  var stripScriptTags = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
  
  // Default options
  options = options || {};
  options.waitFor = options.waitFor || 1000;
  options.protocol = options.protocol || 'http';
  options.cacheSize = options.cacheSize || 1*1024*1024;
  options.cacheRefresh = options.cacheRefresh || 15*60*1000; //15 minutes

  var cache = LRU({
    max: options.cacheSize,
    length: function (n) { return n.length; }
    // dispose: function (key, n) { n.close() }
    // maxAge: 1000 * 60 * 60
  });

  // Refresh all cache entries
  function refreshCache(){
    var urls = cache.keys();
    var iter = function(url, cb){
      getHTMLSnapshot(url, true, cb);
    };
    async.eachLimit(urls, 1, iter, function(err){
      setTimeout(refreshCache, options.cacheRefresh);
    });
  }

  // Remove all script tag from html snapshot
  function stripScripts(snapshot) {
    return snapshot.replace(stripScriptTags, '');
  }

  // Get the URL to the AJAX version of this page
  function getAjaxUrl(req) {
    var fragment = req.param('_escaped_fragment_');
    
    // If no fragment in URL this is not a request for an HTML snapshot
    // of an AJAX page.
    if (!fragment) return undefined;
    
    // Express adds a protocol property to the req object.
    var protocol = req.protocol || options.protocol;

    var url =  protocol + '://' + req.headers.host;
    url += '#!' + decodeURIComponent(fragment);
    return url;
  }

  function getHTMLSnapshot(url, noCache, cb) {
    if(!cb){
      cb = noCache;
      noCache = false;
    }

    if(!noCache){
      var cached = cache.get(url);
      if(cached) return cb(null, cached);
    }

    Browser.visit(url, {waitFor: options.waitFor},
      function(err, browser, status) {
        if(err) return cb(err);

        // links
        var links = browser.queryAll('a');
        links.forEach(function(link) {
          var href = link.getAttribute('href');
          if(href !== null) {
            var absoluteUrl = urlParser.resolve(url, href);
            link.setAttribute('href', absoluteUrl);
          }
        });

        /* Fixed angularjs and zombie metatags */
        var metas = browser.document.querySelectorAll('meta,title,link, base');
        var head = browser.document.querySelector('head');
        _.each(metas, function(meta){
          head.appendChild(meta);
        });

        var snapshot = stripScripts(browser.html());
        cache.set(url, snapshot);
        cb(null, snapshot);
      }
    );
  }

  // Start the cache refresh timer
  setTimeout(refreshCache, options.cacheRefresh);

  // The middleware function
  return function(req, res, next) {
    // Only allow GET requests
    if ('GET' !== req.method) return next();

    // Try to extract the ajax URL from the request
    var url = getAjaxUrl(req);

    // If we aren't being crawled continue to next middleware
    if (!url) return next();

    // Generate the snapshot
    getHTMLSnapshot(url, function(err, snapshot) {
      if (err) {
        console.log('Zombie reported an error: ' + err);
        return next(err);
      }

      res.set("Content-Type", "text/html; charset=utf-8");
      return res.end(snapshot);
    });
  };
};
