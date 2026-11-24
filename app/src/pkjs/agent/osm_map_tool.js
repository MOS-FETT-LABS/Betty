/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

var imageManager = require('../lib/image_transfer').sharedManager;
var location = require('../location');

function schema(properties, required) {
    return {
        type: 'object',
        properties: properties,
        required: required || []
    };
}

function stringSchema(description) {
    return {
        type: 'string',
        description: description
    };
}

function numberSchema(description) {
    return {
        type: 'number',
        description: description
    };
}

function getWatchMapSize() {
    var width = 144;
    var height = 100;
    if (Pebble.getActiveWatchInfo) {
        var platform = Pebble.getActiveWatchInfo().platform;
        if (platform === 'emery') {
            width = 198;
            height = 140;
        } else if (platform === 'chalk') {
            width = 160;
            height = 130;
        } else if (platform === 'gabbro') {
            width = 220;
            height = 150;
        }
    }
    return {width: width, height: height};
}

exports.getDeclarations = function() {
    return [{
        type: 'function',
        name: 'show_openstreetmap_map',
        description: 'Show an OpenStreetMap map card on the watch for a specific destination. Use this only in companionless mode or when Google Maps Platform is unavailable. This does not start phone navigation.',
        parameters: schema({
            destination: stringSchema('Destination name or address.'),
            destination_latitude: numberSchema('Optional destination latitude if already known.'),
            destination_longitude: numberSchema('Optional destination longitude if already known.')
        }, ['destination'])
    }];
};

exports.execute = function(session, call, callback) {
    if (call.name !== 'show_openstreetmap_map') {
        return false;
    }
    var args = normalizeArguments(call);
    var destination = String(args.destination || '').trim();
    var latitude = parseFloat(args.destination_latitude);
    var longitude = parseFloat(args.destination_longitude);
    if (!destination && (isNaN(latitude) || isNaN(longitude))) {
        callback({status: 'rejected', summary: 'Map destination is required.'});
        return true;
    }
    session.handleMessage({data: 'fLoading map'});
    resolveDestination(destination, latitude, longitude, function(err, place) {
        if (err) {
            callback({status: 'error', summary: err.message || String(err)});
            return;
        }
        fetchStaticMap(place, function(fetchErr, map) {
            if (fetchErr) {
                callback({status: 'error', summary: fetchErr.message || String(fetchErr)});
                return;
            }
            var imageId = imageManager.sendImage(map.width, map.height, map.bytes);
            setTimeout(function() {
                session.enqueue({
                    MAP_WIDGET: 1,
                    MAP_WIDGET_IMAGE_ID: imageId,
                    MAP_WIDGET_USER_LOCATION: (map.markerX << 16) | map.markerY
                });
                callback({
                    status: 'ok',
                    provider: 'openstreetmap',
                    summary: 'OpenStreetMap card shown.',
                    display_name: place.displayName,
                    latitude: place.latitude,
                    longitude: place.longitude
                });
            }, 120);
        });
    });
    return true;
};

function normalizeArguments(call) {
    var args = call.arguments || {};
    if (typeof args === 'string') {
        try {
            return JSON.parse(args);
        } catch (e) {
            return {};
        }
    }
    return args;
}

function resolveDestination(destination, latitude, longitude, callback) {
    if (!isNaN(latitude) && !isNaN(longitude)) {
        callback(null, {
            displayName: destination || 'Destination',
            latitude: latitude,
            longitude: longitude
        });
        return;
    }
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(destination);
    fetchJson(url, function(err, results) {
        if (!err && results && results.length) {
            var first = results[0];
            var lat = parseFloat(first.lat);
            var lon = parseFloat(first.lon);
            if (!isNaN(lat) && !isNaN(lon)) {
                callback(null, {
                    displayName: first.display_name || destination,
                    latitude: lat,
                    longitude: lon
                });
                return;
            }
        }
        fetchJson('https://photon.komoot.io/api?limit=1&q=' + encodeURIComponent(destination), function(photonErr, data) {
            if (photonErr) {
                callback(err || photonErr);
                return;
            }
            var feature = data && data.features && data.features[0];
            if (!feature) {
                callback(err || new Error('No OpenStreetMap result found for ' + destination + '.'));
                return;
            }
            var coords = feature.geometry && feature.geometry.coordinates;
            callback(null, {
                displayName: (feature.properties && feature.properties.name) || destination,
                latitude: coords ? coords[1] : NaN,
                longitude: coords ? coords[0] : NaN
            });
        });
    });
}

function fetchStaticMap(place, callback) {
    var size = getWatchMapSize();
    var zoom = 15;
    var n = Math.pow(2, zoom);
    var xFrac = (place.longitude + 180) / 360;
    var latRad = place.latitude * Math.PI / 180;
    var yFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    var tileX = Math.floor(xFrac * n);
    var tileY = Math.floor(yFrac * n);
    var destX = Math.round((xFrac * n - tileX) * 256);
    var destY = Math.round((yFrac * n - tileY) * 256);
    var url = 'https://tile.openstreetmap.org/' + zoom + '/' + tileX + '/' + tileY + '.png';
    fetchBytes(url, function(err, tile) {
        if (err) {
            callback(new Error('OpenStreetMap image failed: ' + err.message));
            return;
        }
        cropTile(tile, size, destX, destY, function(cropErr, cropped) {
            if (cropErr || !cropped) {
                callback(cropErr || new Error('map image could not be cropped (canvas unavailable)'));
                return;
            }
            callback(null, cropped);
        });
    });
}

function cropTile(bytes, size, destX, destY, callback) {
    var hasDom = typeof document !== 'undefined' &&
        typeof Image !== 'undefined' &&
        typeof document.createElement === 'function';
    if (!hasDom) {
        callback(new Error('no canvas in this JS runtime (needs Android Pebble app)'), null);
        return;
    }
    try {
        var blob = new Blob([new Uint8Array(bytes)]);
        var url = URL.createObjectURL(blob);
        var img = new Image();
        img.onload = function() {
            URL.revokeObjectURL(url);
            try {
                var left = destX - Math.floor(size.width / 2);
                var top = destY - Math.floor(size.height / 2);
                left = Math.max(0, Math.min(256 - size.width, left));
                top = Math.max(0, Math.min(256 - size.height, top));
                var canvas = document.createElement('canvas');
                canvas.width = size.width;
                canvas.height = size.height;
                canvas.getContext('2d').drawImage(img, left, top, size.width, size.height, 0, 0, size.width, size.height);
                var dataUrl = canvas.toDataURL('image/png');
                var raw = atob(dataUrl.substring(dataUrl.indexOf(',') + 1));
                var out = new Array(raw.length);
                for (var i = 0; i < raw.length; i++) {
                    out[i] = raw.charCodeAt(i) & 0xff;
                }
                callback(null, {
                    width: size.width,
                    height: size.height,
                    bytes: out,
                    markerX: destX - left,
                    markerY: destY - top
                });
            } catch (e) {
                callback(null, null);
            }
        };
        img.onerror = function() {
            URL.revokeObjectURL(url);
            callback(new Error('tile image decode failed'), null);
        };
        img.src = url;
    } catch (e) {
        callback(e, null);
    }
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
    req.timeout = 12000;
    req.setRequestHeader('Accept', 'application/json');
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(new Error('HTTP ' + req.status + ': ' + String(req.responseText || '').substring(0, 120)));
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
        finish(new Error('request timed out'));
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
        // Older PebbleKit JS hosts ignore responseType; responseText fallback below handles them.
    }
    if (req.overrideMimeType) {
        req.overrideMimeType('text/plain; charset=x-user-defined');
    }
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(new Error('HTTP ' + req.status + ': ' + String(req.responseText || '').substring(0, 120)));
            return;
        }
        finish(null, responseToBytes(req));
    };
    req.onerror = function() {
        finish(new Error('network error'));
    };
    req.ontimeout = function() {
        finish(new Error('request timed out'));
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
