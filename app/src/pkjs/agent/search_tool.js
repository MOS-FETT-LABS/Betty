/**
 * Copyright 2026 Ashley Cooper
 *
 * Licensed under the Apache License, Version 2.0.
 *
 * Keyless live web search for Betty's companionless runtime. Replaces Gemini's
 * built-in google_search grounding: the model calls search_web, the phone
 * fetches DuckDuckGo Instant Answers (and Wikipedia as fallback), and the
 * compact result goes back through the normal tool-result loop.
 */

var DDG_URL = 'https://api.duckduckgo.com/';
var WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';
var RESULT_LIMIT = 1800;

function fetchJson(url, timeoutMs, callback) {
    var req = new XMLHttpRequest();
    var finished = false;
    function finish(err, value) {
        if (finished) {
            return;
        }
        finished = true;
        callback(err, value);
    }
    req.open('GET', url, true);
    req.timeout = timeoutMs;
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(new Error('search: HTTP ' + req.status));
            return;
        }
        try {
            finish(null, JSON.parse(req.responseText));
        } catch (e) {
            finish(e);
        }
    };
    req.onerror = function() {
        finish(new Error('search: request failed'));
    };
    req.ontimeout = function() {
        finish(new Error('search: timed out'));
    };
    req.send(null);
}

function ddgAbstract(data) {
    if (!data) {
        return '';
    }
    var text = data.AbstractText || data.Abstract || '';
    if (!text && data.Answer && typeof data.Answer === 'string') {
        text = data.Answer;
    }
    if (text) {
        var source = data.AbstractSource || 'DuckDuckGo';
        return text + '\n(source: ' + source + ')';
    }
    var topics = [];
    if (Array.isArray(data.RelatedTopics)) {
        data.RelatedTopics.forEach(function(topic) {
            if (topics.length >= 3) {
                return;
            }
            if (topic && typeof topic.Text === 'string' && topic.Text) {
                topics.push(topic.Text);
            }
        });
    }
    return topics.join('\n');
}

function wikiSummary(title, callback) {
    var url = 'https://en.wikipedia.org/api/rest_v1/page/summary/' +
        encodeURIComponent(title);
    fetchJson(url, 10000, function(err, data) {
        if (err || !data || !data.extract) {
            callback(err, '');
            return;
        }
        callback(null, data.extract + '\n(source: Wikipedia)');
    });
}

function wikiSearch(query, callback) {
    var url = WIKI_SEARCH_URL +
        '?action=query&list=search&srsearch=' + encodeURIComponent(query) +
        '&format=json&srlimit=1&origin=*';
    fetchJson(url, 10000, function(err, data) {
        if (err) {
            callback(err, '');
            return;
        }
        var hits = data && data.query && data.query.search;
        if (hits && hits.length > 0 && hits[0].title) {
            wikiSummary(hits[0].title, callback);
            return;
        }
        callback(null, '');
    });
}

function searchWeb(query, callback) {
    var ddgUrl = DDG_URL + '?q=' + encodeURIComponent(query) +
        '&format=json&no_html=1&skip_disambig=1';
    fetchJson(ddgUrl, 10000, function(err, data) {
        var abstract = ddgAbstract(data);
        if (abstract) {
            callback(null, abstract.substring(0, RESULT_LIMIT));
            return;
        }
        wikiSearch(query, function(wikiErr, wikiText) {
            if (wikiText) {
                callback(wikiErr, wikiText.substring(0, RESULT_LIMIT));
                return;
            }
            callback(wikiErr || err || new Error('search: no results'), '');
        });
    });
}

exports.getDeclarations = function() {
    return [{
        type: 'function',
        name: 'search_web',
        description: 'Search the live web for current facts, news, scores, prices, or anything time-sensitive. Returns a short text answer.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The web search query, in plain keywords'
                }
            },
            required: ['query']
        }
    }];
};

exports.execute = function(call, callback) {
    var query = call.arguments && call.arguments.query;
    if (!query || typeof query !== 'string') {
        callback({
            error: 'search_web needs a query string'
        });
        return;
    }
    searchWeb(query.substring(0, 300), function(err, text) {
        if (err && !text) {
            callback({
                error: 'web search failed: ' + err.message
            });
            return;
        }
        callback({
            query: query,
            result: text || 'no results found'
        });
    });
};
