/**
 * Copyright 2026 Ashley Cooper
 *
 * Licensed under the Apache License, Version 2.0.
 *
 * Companionless web images: search Wikimedia Commons and show a result as a
 * watch image card. Mirrors WebImageCompanionTool.kt from the Billy companion,
 * but runs in PebbleKit JS. PNG sources are sent as-is; other raster formats
 * are converted on a canvas when the host PKJS runtime has a DOM (the Android
 * Pebble app runs PebbleKit JS in a WebView), and skipped otherwise.
 */

var imageManager = require('../lib/image_transfer').sharedManager;

var MAX_DIM = 190;
var TIMEOUT_MS = 10000;

exports.getDeclarations = function() {
    return [{
        type: 'function',
        name: 'show_web_image_search',
        description: 'Search public web images (Wikimedia Commons) and show one as a watch image card. Use this for picture requests such as landmarks, places, animals, or products.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The subject to search for, such as a landmark, product, person, animal, or place.'
                }
            },
            required: ['query']
        }
    }];
};

exports.execute = function(session, call, callback) {
    if (call.name !== 'show_web_image_search') {
        return false;
    }
    var args = call.arguments || {};
    var query = String(args.query || '').trim();
    if (!query) {
        callback({status: 'rejected', summary: 'Image subject is required.'});
        return true;
    }
    session.handleMessage({data: 'fLoading image'});
    searchCommons(query, function(err, results) {
        if (err) {
            callback({status: 'error', summary: 'Web image search failed: ' + err.message});
            return;
        }
        sendFirstUsableImage(session, results, function(sendErr, shown) {
            if (sendErr) {
                callback({status: 'error', summary: 'Web image lookup failed: ' + sendErr.message});
                return;
            }
            callback({
                status: 'ok',
                provider: 'wikimedia',
                summary: 'Web image: ' + shown.title + '\nWikimedia Commons',
                query: query,
                title: shown.title,
                source_url: shown.sourceUrl
            });
        });
    });
    return true;
};

function searchCommons(query, callback) {
    var url = 'https://commons.wikimedia.org/w/api.php' +
        '?action=query&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=' +
        encodeURIComponent(query) +
        '&prop=imageinfo&iiprop=url%7Cmime%7Csize&iiurlwidth=' + (MAX_DIM * 2) + '&format=json';
    fetchJson(url, function(err, root) {
        if (err) {
            callback(err, null);
            return;
        }
        var pages = root && root.query && root.query.pages;
        var results = [];
        if (pages) {
            Object.keys(pages).forEach(function(key) {
                var page = pages[key];
                var info = page && page.imageinfo && page.imageinfo[0];
                if (!info) {
                    return;
                }
                var mime = String(info.mime || '');
                if (mime.indexOf('image/') !== 0 || mime === 'image/svg+xml') {
                    return;
                }
                results.push({
                    title: String(page.title || ''),
                    sourceUrl: String(info.descriptionurl || info.url || ''),
                    imageUrl: String(info.thumburl || info.url || ''),
                    mime: mime,
                    width: info.thumbwidth || info.width || 0,
                    height: info.thumbheight || info.height || 0
                });
            });
        }
        if (results.length === 0) {
            callback(new Error('no web image found for ' + query), null);
            return;
        }
        callback(null, results);
    });
}

function sendFirstUsableImage(session, results, callback) {
    var pngOnly = [];
    var others = [];
    results.forEach(function(result) {
        if (result.mime === 'image/png') {
            pngOnly.push(result);
        } else {
            others.push(result);
        }
    });
    var queue = pngOnly.concat(others);
    var index = 0;
    function next() {
        if (index >= queue.length) {
            callback(new Error('no image could be decoded'), null);
            return;
        }
        var candidate = queue[index++];
        session.handleMessage({data: 'fFetching image'});
        fetchBytes(candidate.imageUrl, function(err, bytes) {
            if (err) {
                next();
                return;
            }
            if (candidate.mime === 'image/png') {
                show(session, candidate, bytes, callback);
                return;
            }
            convertToPng(bytes, function(convErr, pngBytes) {
                if (convErr || !pngBytes) {
                    next();
                    return;
                }
                show(session, candidate, pngBytes, callback);
            });
        });
    }
    next();
}

function show(session, candidate, bytes, callback) {
    var dims = scaledDimensions(candidate.width, candidate.height, bytes);
    var imageId = imageManager.sendImage(dims.width, dims.height, bytes);
    setTimeout(function() {
        session.enqueue({
            MAP_WIDGET: 1,
            MAP_WIDGET_IMAGE_ID: imageId,
            MAP_WIDGET_USER_LOCATION: 0
        });
        callback(null, {
            title: candidate.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').substring(0, 60),
            sourceUrl: candidate.sourceUrl
        });
    }, 120);
}

function scaledDimensions(width, height, bytes) {
    if (typeof height === 'number' && typeof width === 'number' && width > 0 && height > 0) {
        var scale = Math.min(1, MAX_DIM / Math.max(width, height));
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale))
        };
    }
    return {width: MAX_DIM, height: Math.round(MAX_DIM * 0.75)};
}

function convertToPng(bytes, callback) {
    var hasDom = typeof document !== 'undefined' &&
        typeof Image !== 'undefined' &&
        typeof document.createElement === 'function';
    if (!hasDom) {
        callback(new Error('this image format needs the Android Pebble app'), null);
        return;
    }
    try {
        var blob = new Blob([new Uint8Array(bytes)]);
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
            URL.revokeObjectURL(url);
            try {
                var scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
                var canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                var dataUrl = canvas.toDataURL('image/png');
                callback(null, base64ToBytes(dataUrl.substring(dataUrl.indexOf(',') + 1)));
            } catch (e) {
                callback(e, null);
            }
        };
        img.onerror = function() {
            URL.revokeObjectURL(url);
            callback(new Error('image decode failed'), null);
        };
        img.src = url;
    } catch (e) {
        callback(e, null);
    }
}

function base64ToBytes(b64) {
    var raw = atob(b64);
    var bytes = new Array(raw.length);
    for (var i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i) & 0xff;
    }
    return bytes;
}

function fetchJson(url, callback) {
    var finished = false;
    var req = new XMLHttpRequest();
    function finish(err, value) {
        if (finished) {
            return;
        }
        finished = true;
        callback(err, value);
    }
    req.open('GET', url, true);
    req.timeout = TIMEOUT_MS;
    req.setRequestHeader('Accept', 'application/json');
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(new Error('HTTP ' + req.status));
            return;
        }
        try {
            finish(null, JSON.parse(req.responseText));
        } catch (e) {
            finish(e);
        }
    };
    req.onerror = function() {
        finish(new Error('network error'));
    };
    req.ontimeout = function() {
        finish(new Error('timed out'));
    };
    req.send();
}

function fetchBytes(url, callback) {
    var finished = false;
    var req = new XMLHttpRequest();
    function finish(err, value) {
        if (finished) {
            return;
        }
        finished = true;
        callback(err, value);
    }
    req.open('GET', url, true);
    req.timeout = 15000;
    try {
        req.responseType = 'arraybuffer';
    } catch (e) {
    }
    if (req.overrideMimeType) {
        req.overrideMimeType('text/plain; charset=x-user-defined');
    }
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(new Error('HTTP ' + req.status));
            return;
        }
        finish(null, responseToBytes(req));
    };
    req.onerror = function() {
        finish(new Error('network error'));
    };
    req.ontimeout = function() {
        finish(new Error('timed out'));
    };
    req.send();
}

function responseToBytes(req) {
    if (req.response && typeof Uint8Array !== 'undefined' && typeof req.response !== 'string') {
        var view = new Uint8Array(req.response);
        var bytes = new Array(view.length);
        for (var i = 0; i < view.length; i++) {
            bytes[i] = view[i];
        }
        return bytes;
    }
    var text = req.responseText || '';
    var result = new Array(text.length);
    for (var j = 0; j < text.length; j++) {
        result[j] = text.charCodeAt(j) & 0xff;
    }
    return result;
}
