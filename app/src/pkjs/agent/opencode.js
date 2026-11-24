/**
 * Copyright 2026 Ashley Cooper
 *
 * Fork of Billy's gemini.js provider seam (Apache 2.0, Bobby/Billy lineage).
 * Licensed under the Apache License, Version 2.0.
 *
 * OpenCode Go provider for Betty's companionless runtime. OpenAI-compatible
 * chat completions at https://opencode.ai/inference/go/v1/chat/completions.
 */

var config = require('../config');

var CHAT_COMPLETIONS_URL = 'https://opencode.ai/inference/go/v1/chat/completions';
var OPENCODE_REQUEST_TIMEOUT_MS = 45000;
var USER_AGENT = 'Betty/0.1 (Pebble watchapp)';

function buildTools(options) {
    var tools = [];
    if (options.tools && options.tools.length > 0) {
        options.tools.forEach(function(tool) {
            if (tool.type === 'function' && tool.name) {
                tools.push({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: normalizeFunctionParameters(tool.parameters)
                    }
                });
            }
        });
    }
    return tools;
}

function normalizeFunctionParameters(parameters) {
    if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) {
        return parameters;
    }
    return {
        type: 'object',
        properties: {}
    };
}

function buildMessages(history, systemInstruction) {
    var messages = [];
    if (systemInstruction) {
        messages.push({
            role: 'system',
            content: systemInstruction
        });
    }
    if (Array.isArray(history)) {
        history.forEach(function(item) {
            var message = historyItemToMessage(item);
            if (message) {
                messages.push(message);
            }
        });
    }
    return messages;
}

function historyItemToMessage(item) {
    if (!item || !item.type) {
        return null;
    }
    if (item.type === 'user_input') {
        return {
            role: 'user',
            content: internalContentToText(item.content)
        };
    }
    if (item.type === 'assistant_text') {
        return {
            role: 'assistant',
            content: item.content || ''
        };
    }
    if (item.type === 'assistant_tool_calls') {
        var toolCalls = [];
        (item.calls || []).forEach(function(call) {
            toolCalls.push({
                id: call.id || 'call_' + toolCalls.length,
                type: 'function',
                function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments || {})
                }
            });
        });
        if (toolCalls.length === 0) {
            return null;
        }
        return {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls
        };
    }
    if (item.type === 'function_result') {
        return {
            role: 'tool',
            tool_call_id: item.call_id || 'call_0',
            content: internalResultToText(item.result)
        };
    }
    if (item.role && item.parts) {
        return geminiContentToMessage(item);
    }
    if (item.role && typeof item.content !== 'undefined') {
        return item;
    }
    return null;
}

function internalContentToText(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return String(content || '');
    }
    var parts = [];
    content.forEach(function(part) {
        if (part && typeof part.text === 'string') {
            parts.push(part.text);
        }
    });
    return parts.join('');
}

function internalResultToText(result) {
    if (typeof result === 'string') {
        return result;
    }
    if (Array.isArray(result)) {
        var parts = [];
        result.forEach(function(part) {
            if (part && typeof part.text === 'string') {
                parts.push(part.text);
            }
        });
        if (parts.length === 1) {
            try {
                return JSON.stringify(JSON.parse(parts[0]));
            } catch (e) {
                return parts[0];
            }
        }
        return parts.join('\n');
    }
    return JSON.stringify(result || {});
}

function geminiContentToMessage(content) {
    var text = '';
    var functionCalls = [];
    (content.parts || []).forEach(function(part) {
        if (typeof part.text === 'string') {
            text += part.text;
        } else if (part.functionCall || part.function_call) {
            var call = part.functionCall || part.function_call;
            functionCalls.push({
                id: call.id,
                name: call.name,
                arguments: call.args || call.arguments || {}
            });
        }
    });
    if (functionCalls.length > 0) {
        return {
            type: 'assistant_tool_calls',
            calls: functionCalls
        };
    }
    if (content.role === 'model' || content.role === 'assistant') {
        return {
            type: 'assistant_text',
            content: text
        };
    }
    return {
        type: 'user_input',
        content: [{
            type: 'text',
            text: text
        }]
    };
}

function extractToolCalls(message) {
    var calls = [];
    if (message && Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach(function(call, index) {
            var fn = call.function || {};
            var args = {};
            if (typeof fn.arguments === 'string') {
                try {
                    args = JSON.parse(fn.arguments);
                } catch (e) {
                    args = {
                        _raw: fn.arguments
                    };
                }
            } else if (fn.arguments && typeof fn.arguments === 'object') {
                args = fn.arguments;
            }
            calls.push({
                id: call.id || ('call_' + index),
                name: fn.name,
                arguments: args
            });
        });
    }
    if (calls.length === 0) {
        var leakedCall = extractLeakedClarificationCall(message ? message.content : null);
        if (leakedCall) {
            calls.push(leakedCall);
        }
    }
    return calls;
}

function extractLeakedClarificationCall(text) {
    if (!text) {
        return null;
    }
    var compact = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compact.indexOf('askclarifyingquestion') === -1) {
        return null;
    }
    var questionMatch = /question\s*=\s*["']([^"']{1,160})["']/i.exec(text);
    var optionsMatch = /options\s*=\s*\[([\s\S]{1,400}?)\]/i.exec(text);
    if (!questionMatch || !optionsMatch) {
        return null;
    }
    var options = [];
    var optionRegex = /["']([^"']{1,64})["']/g;
    var match;
    while ((match = optionRegex.exec(optionsMatch[1])) && options.length < 4) {
        options.push(match[1]);
    }
    if (options.length < 1) {
        return null;
    }
    return {
        id: undefined,
        name: 'ask_clarifying_question',
        arguments: {
            question: questionMatch[1],
            options: options
        }
    };
}

function buildHistoryItems(message) {
    var items = [];
    if (!message) {
        return items;
    }
    var calls = [];
    if (Array.isArray(message.tool_calls)) {
        message.tool_calls.forEach(function(call) {
            var fn = call.function || {};
            var args = {};
            if (typeof fn.arguments === 'string') {
                try {
                    args = JSON.parse(fn.arguments);
                } catch (e) {
                    args = {
                        _raw: fn.arguments
                    };
                }
            } else if (fn.arguments && typeof fn.arguments === 'object') {
                args = fn.arguments;
            }
            calls.push({
                id: call.id,
                name: fn.name,
                arguments: args
            });
        });
    }
    if (calls.length > 0) {
        items.push({
            type: 'assistant_tool_calls',
            calls: calls
        });
    }
    if (typeof message.content === 'string' && message.content.length > 0) {
        items.push({
            type: 'assistant_text',
            content: message.content
        });
    }
    return items;
}

exports.generate = function(input, options, callback) {
    options = options || {};
    var apiKey = config.getOpenCodeApiKey();
    if (!apiKey) {
        callback(new Error('OpenCode API key is not configured. Open Betty settings and add an OpenCode Go API key.'));
        return;
    }
    var model = config.getOpenCodeModel();
    var body = {
        model: model,
        messages: buildMessages(input, options.systemInstruction),
        max_tokens: 2048
    };
    var tools = buildTools(options);
    if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
    }
    var finished = false;
    var req = new XMLHttpRequest();
    function finish(err, value) {
        if (finished) {
            return;
        }
        finished = true;
        callback(err, value);
    }
    req.open('POST', CHAT_COMPLETIONS_URL, true);
    req.timeout = OPENCODE_REQUEST_TIMEOUT_MS;
    req.setRequestHeader('Content-Type', 'application/json');
    req.setRequestHeader('Authorization', 'Bearer ' + apiKey);
    req.setRequestHeader('User-Agent', USER_AGENT);
    if (options.sessionId) {
        req.setRequestHeader('x-opencode-session', options.sessionId);
    }
    req.onload = function() {
        if (req.readyState !== 4) {
            return;
        }
        if (req.status < 200 || req.status >= 300) {
            finish(parseError(req.status, req.responseText, model));
            return;
        }
        try {
            var response = JSON.parse(req.responseText);
            var message = response.choices && response.choices[0] && response.choices[0].message;
            finish(null, {
                text: (message && typeof message.content === 'string') ? message.content : '',
                functionCalls: extractToolCalls(message),
                interactionId: response.id || null,
                historyItems: buildHistoryItems(message),
                raw: response
            });
        } catch (e) {
            finish(e);
        }
    };
    req.onerror = function() {
        finish(new Error('OpenCode request failed before a response was received.'));
    };
    req.ontimeout = function() {
        finish(new Error('OpenCode request timed out. Please try again.'));
    };
    req.send(JSON.stringify(body));
};

function parseError(status, responseText, model) {
    var message = responseText;
    var code = '';
    try {
        var parsed = JSON.parse(responseText);
        if (parsed.error) {
            message = parsed.error.message || message;
            code = parsed.error.type || parsed.error.status || parsed.error.code || '';
        }
    } catch (e) {
    }
    message = message || 'unknown error';
    var lowerMessage = message.toLowerCase();
    if (status === 401) {
        message = 'OpenCode did not accept this API key. Copy a valid OpenCode Go API key from the OpenCode Console.';
    }
    if (status === 403 && (lowerMessage.indexOf('entitlement') !== -1 || lowerMessage.indexOf('subscription') !== -1)) {
        message = 'This OpenCode key has no active Go subscription. Check your subscription and privacy/region settings in the OpenCode Console.';
    }
    if (message.length > 180) {
        message = message.substring(0, 177) + '...';
    }
    var err = new Error('OpenCode ' + model + ' failed: ' + message + (code ? ' (' + code + ')' : ''));
    err.status = status;
    err.code = code;
    err.messageText = message;
    return err;
}

function shouldFallback(error) {
    var text = (error.message + ' ' + error.code + ' ' + error.messageText).toLowerCase();
    return error.status === 429 ||
        error.status === 500 ||
        error.status === 502 ||
        error.status === 503 ||
        error.status === 504;
}

exports.hasUsableResponse = function(response) {
    return !!(response &&
        ((response.text && response.text.trim && response.text.trim().length > 0) ||
            (response.functionCalls && response.functionCalls.length > 0)));
};
