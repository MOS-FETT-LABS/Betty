package com.tombo.billyassistant.companion.agent

import com.tombo.billyassistant.companion.agent.tools.ClarificationCard
import com.tombo.billyassistant.companion.agent.tools.CompanionToolExecution
import com.tombo.billyassistant.companion.agent.tools.WatchWeatherCurrent
import com.tombo.billyassistant.companion.agent.tools.WatchImage
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.UUID

/**
 * OpenCode Go provider for Betty Companion (OpenAI-compatible chat
 * completions). Wire-level counterpart of app/src/pkjs/agent/opencode.js.
 */
class OpenCodeClient : AssistantClient {
    override fun describeConfiguration(apiKey: String): String {
        return if (apiKey.isBlank()) {
            "OpenCode Go API key is not configured."
        } else {
            "OpenCode Go API key is stored locally. Use Verify key to check it."
        }
    }

    override fun createRequest(prompt: String, apiKey: String): GeminiRequestPlan {
        if (prompt.isBlank()) {
            return GeminiRequestPlan.Invalid("Prompt is blank.")
        }
        if (normalizeApiKey(apiKey).isBlank()) {
            return GeminiRequestPlan.Invalid("OpenCode Go API key is missing.")
        }

        return GeminiRequestPlan.Ready(
            model = DEFAULT_MODEL,
            prompt = prompt.trim(),
        )
    }

    override fun testKey(apiKey: String): GeminiKeyTestResult {
        val normalizedKey = normalizeApiKey(apiKey)
        if (normalizedKey.isBlank()) {
            return GeminiKeyTestResult.Failed("OpenCode Go API key is missing.")
        }

        return try {
            val connection = (URL(CHAT_COMPLETIONS_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $normalizedKey")
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("x-opencode-session", SESSION_ID)
            }
            val body = JSONObject()
                .put("model", DEFAULT_MODEL)
                .put(
                    "messages",
                    JSONArray().put(
                        JSONObject().put("role", "user").put("content", "Reply with OK."),
                    ),
                )
                .put("max_tokens", 8)
                .toString()
            connection.outputStream.use { output ->
                output.write(body.toByteArray(Charsets.UTF_8))
            }

            val responseCode = connection.responseCode
            val responseText = (if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            })?.bufferedReader()?.use { it.readText() }.orEmpty()

            if (responseCode in 200..299) {
                GeminiKeyTestResult.Passed("OpenCode Go key works with $DEFAULT_MODEL.")
            } else {
                GeminiKeyTestResult.Failed(
                    "OpenCode returned HTTP $responseCode: ${extractErrorMessage(responseText)}",
                )
            }
        } catch (e: Exception) {
            GeminiKeyTestResult.Failed("OpenCode key verification failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    override fun generateText(prompt: String, apiKey: String): GeminiTextResult {
        val result = generateWithTools(
            prompt = prompt,
            apiKey = apiKey,
            toolDeclarations = JSONArray(),
            toolExecutor = { name, _ ->
                CompanionToolExecution(JSONObject().put("error", "Tool not available: $name"))
            },
        )
        return when (result) {
            is CompanionAgentResult.Passed -> GeminiTextResult.Passed(result.text)
            is CompanionAgentResult.Failed -> GeminiTextResult.Failed(result.reason)
        }
    }

    override fun chooseImageCandidate(
        prompt: String,
        apiKey: String,
        candidates: List<GeminiImageCandidate>,
    ): GeminiImageChoice? {
        val normalizedKey = normalizeApiKey(apiKey)
        if (normalizedKey.isBlank() || candidates.isEmpty()) {
            return null
        }
        val instruction =
            "Choose the single candidate photo that best matches this watch request: \"$prompt\". " +
                "Judge visible content first, then filename/folder/date only as weak hints. " +
                "If the request asks for a dog, choose a real dog, not a toy, doll, drawing, or person. " +
                "If the request asks for family, children, or a named person, choose real people, not toys or dolls. " +
                "If no candidate visibly matches, return confidence 0 instead of guessing. " +
                "Reply only as JSON like {\"index\":0,\"confidence\":85,\"reason\":\"short reason\"}."
        val content = JSONArray().put(JSONObject().put("type", "text").put("text", instruction))
        candidates.forEach { candidate ->
            content.put(
                JSONObject()
                    .put("type", "text")
                    .put("text", "Candidate ${candidate.index}: ${candidate.label}"),
            )
            content.put(
                JSONObject()
                    .put("type", "image_url")
                    .put(
                        "image_url",
                        JSONObject()
                            .put(
                                "url",
                                "data:${candidate.mimeType};base64,${candidate.base64Data}",
                            ),
                    ),
            )
        }
        val response = postChat(
            apiKey = normalizedKey,
            model = DEFAULT_MODEL,
            messages = JSONArray().put(
                JSONObject().put("role", "user").put("content", content),
            ),
        )
        if (response is ChatResult.Failed) {
            return null
        }
        val text = extractResponseText((response as ChatResult.Passed).raw)
        val json = runCatching { JSONObject(text) }.getOrNull()
        val jsonIndex = json?.optInt("index", -1) ?: -1
        if (jsonIndex >= 0 && candidates.any { it.index == jsonIndex }) {
            return GeminiImageChoice(
                index = jsonIndex,
                confidence = json?.optInt("confidence", 50)?.coerceIn(0, 100) ?: 50,
                reason = json?.optString("reason").orEmpty(),
            )
        }
        val regexIndex = Regex("""\b(\d{1,2})\b""").find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()
        return regexIndex
            ?.takeIf { index -> candidates.any { it.index == index } }
            ?.let { index -> GeminiImageChoice(index = index, confidence = 45, reason = text.take(80)) }
    }

    override fun generateWithTools(
        prompt: String,
        apiKey: String,
        toolDeclarations: JSONArray,
        toolExecutor: (String, JSONObject) -> CompanionToolExecution,
    ): CompanionAgentResult {
        val normalizedKey = normalizeApiKey(apiKey)
        if (normalizedKey.isBlank()) {
            return CompanionAgentResult.Failed("OpenCode Go API key is missing in the companion app.")
        }
        if (prompt.isBlank()) {
            return CompanionAgentResult.Failed("Prompt is blank.")
        }

        val messages = JSONArray()
            .put(systemMessage())
            .put(
                JSONObject()
                    .put("role", "user")
                    .put("content", localTimeInstruction() +
                        " If this request uses relative dates or times, use that current date/time. User request: " +
                        prompt.trim()),
            )
        var pendingWatchImage: WatchImage? = null
        var pendingWatchWeather: WatchWeatherCurrent? = null
        repeat(MAX_TOOL_ITERATIONS) {
            val response = generateStructuredBestEffort(normalizedKey, messages, toolDeclarations)
            if (response is ChatResult.Failed) {
                return CompanionAgentResult.Failed(response.reason)
            }
            val raw = (response as ChatResult.Passed).raw
            val message = extractMessage(raw)
            val functionCalls = extractToolCalls(message)
            if (functionCalls.isEmpty()) {
                val text = message?.optString("content").orEmpty().ifBlank {
                    "I did not receive a usable answer."
                }
                clarificationCardFromLeakedToolText(text)?.let { card ->
                    return CompanionAgentResult.Passed(
                        text = "",
                        watchImage = pendingWatchImage,
                        watchWeatherCurrent = pendingWatchWeather,
                        clarificationCard = card,
                    )
                }
                maybeClarificationCardFromText(text, prompt)?.let { card ->
                    return CompanionAgentResult.Passed(
                        text = "",
                        watchImage = pendingWatchImage,
                        watchWeatherCurrent = pendingWatchWeather,
                        clarificationCard = card,
                    )
                }
                return CompanionAgentResult.Passed(
                    text = text,
                    watchImage = pendingWatchImage,
                    watchWeatherCurrent = pendingWatchWeather,
                )
            }
            messages.put(assistantToolCallMessage(message))
            functionCalls.forEach { call ->
                val result = toolExecutor(call.name, call.args)
                result.watchImage?.let { pendingWatchImage = it }
                result.watchWeatherCurrent?.let { pendingWatchWeather = it }
                result.clarificationCard?.let {
                    return CompanionAgentResult.Passed(
                        text = "",
                        watchImage = pendingWatchImage,
                        watchWeatherCurrent = pendingWatchWeather,
                        clarificationCard = it,
                    )
                }
                messages.put(
                    JSONObject()
                        .put("role", "tool")
                        .put("tool_call_id", call.id)
                        .put("content", result.response.toString()),
                )
                if (result.followUpParts.length() > 0) {
                    messages.put(
                        JSONObject()
                            .put("role", "user")
                            .put(
                                "content",
                                "Use the tool result and attached data to answer the user's watch request. Be concrete and do not answer with only a count.",
                            ),
                    )
                }
                result.finalText?.let {
                    return CompanionAgentResult.Passed(
                        text = it,
                        watchImage = pendingWatchImage,
                        watchWeatherCurrent = pendingWatchWeather,
                    )
                }
            }
        }

        return CompanionAgentResult.Failed("I used too many tool steps and stopped before finishing.")
    }

    private fun generateStructuredBestEffort(
        apiKey: String,
        messages: JSONArray,
        toolDeclarations: JSONArray,
    ): ChatResult {
        var lastFailure: ChatResult.Failed? = null
        MODEL_CANDIDATES.forEach { model ->
            val content = postChat(apiKey, model, messages, toolDeclarations)
            if (content is ChatResult.Passed && content.isUsable()) {
                return content
            }
            if (content is ChatResult.Failed) {
                lastFailure = content
                if (!shouldTryNextModel(content.reason)) {
                    return content
                }
            } else {
                lastFailure = ChatResult.Failed("OpenCode returned an empty answer.")
            }
        }
        return lastFailure ?: ChatResult.Failed("OpenCode returned an empty answer.")
    }

    private fun postChat(
        apiKey: String,
        model: String,
        messages: JSONArray,
        toolDeclarations: JSONArray = JSONArray(),
    ): ChatResult {
        return try {
            val connection = (URL(CHAT_COMPLETIONS_URL).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = REQUEST_TIMEOUT_MS
                readTimeout = REQUEST_TIMEOUT_MS
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $apiKey")
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("x-opencode-session", SESSION_ID)
            }
            val body = JSONObject()
                .put("model", model)
                .put("messages", messages)
                .put("max_tokens", MAX_OUTPUT_TOKENS)
            if (toolDeclarations.length() > 0) {
                body.put("tools", openAiTools(toolDeclarations))
                body.put("tool_choice", "auto")
            }
            connection.outputStream.use { output ->
                output.write(body.toString().toByteArray(Charsets.UTF_8))
            }

            val responseCode = connection.responseCode
            val responseText = (if (responseCode in 200..299) {
                connection.inputStream
            } else {
                connection.errorStream
            })?.bufferedReader()?.use { it.readText() }.orEmpty()

            if (responseCode in 200..299) {
                ChatResult.Passed(responseText)
            } else {
                ChatResult.Failed(
                    "OpenCode returned HTTP $responseCode: ${extractErrorMessage(responseText)}",
                )
            }
        } catch (e: Exception) {
            ChatResult.Failed("OpenCode request failed: ${e.message ?: e.javaClass.simpleName}")
        }
    }

    private fun openAiTools(toolDeclarations: JSONArray): JSONArray {
        val tools = JSONArray()
        for (i in 0 until toolDeclarations.length()) {
            val declaration = toolDeclarations.optJSONObject(i) ?: continue
            tools.put(
                JSONObject()
                    .put("type", "function")
                    .put(
                        "function",
                        JSONObject()
                            .put("name", declaration.optString("name"))
                            .put("description", declaration.optString("description"))
                            .put(
                                "parameters",
                                declaration.opt("parameters") ?: JSONObject().put("type", "object").put("properties", JSONObject()),
                            ),
                    ),
            )
        }
        return tools
    }

    private fun extractErrorMessage(responseText: String): String {
        if (responseText.isBlank()) {
            return "empty error response"
        }
        val message = try {
            val parsed = JSONObject(responseText)
            val message = parsed.optJSONObject("error")?.optString("message").orEmpty()
            message.ifBlank { responseText }
        } catch (_: Exception) {
            responseText
        }
        if (message.contains("EntitlementError", ignoreCase = true) ||
            message.contains("subscription", ignoreCase = true)
        ) {
            return "This OpenCode key has no active Go subscription. Check your subscription and privacy/region settings in the OpenCode Console."
                .take(MAX_ERROR_LENGTH)
        }
        if (message.contains("api key", ignoreCase = true) && message.contains("invalid", ignoreCase = true)) {
            return "OpenCode did not accept this API key. Copy a valid OpenCode Go API key from the OpenCode Console."
                .take(MAX_ERROR_LENGTH)
        }
        return message.take(MAX_ERROR_LENGTH)
    }

    private fun extractMessage(responseText: String): JSONObject? {
        return try {
            JSONObject(responseText)
                .optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
        } catch (_: Exception) {
            null
        }
    }

    private fun extractResponseText(responseText: String): String {
        return extractMessage(responseText)?.optString("content").orEmpty()
    }

    private fun extractToolCalls(message: JSONObject?): List<OpenCodeToolCall> {
        val toolCalls = message?.optJSONArray("tool_calls") ?: return emptyList()
        val calls = buildList {
            for (i in 0 until toolCalls.length()) {
                val toolCall = toolCalls.optJSONObject(i) ?: continue
                val function = toolCall.optJSONObject("function") ?: continue
                val name = function.optString("name")
                if (name.isBlank()) {
                    continue
                }
                val args = try {
                    JSONObject(function.optString("arguments"))
                } catch (_: Exception) {
                    JSONObject()
                }
                add(
                    OpenCodeToolCall(
                        id = toolCall.optString("id").ifBlank { "call_$i" },
                        name = name,
                        args = args,
                    ),
                )
            }
        }
        if (calls.isNotEmpty()) {
            return calls
        }
        val leaked = clarificationCardFromLeakedToolText(message?.optString("content").orEmpty())
            ?: return emptyList()
        return listOf(
            OpenCodeToolCall(
                id = "call_clarify",
                name = "ask_clarifying_question",
                args = JSONObject()
                    .put("question", leaked.question)
                    .put("options", JSONArray(leaked.options)),
            ),
        )
    }

    private fun assistantToolCallMessage(message: JSONObject?): JSONObject {
        val toolCalls = JSONArray()
        message?.optJSONArray("tool_calls")?.let { calls ->
            for (i in 0 until calls.length()) {
                toolCalls.put(calls.get(i))
            }
        }
        return JSONObject()
            .put("role", "assistant")
            .putOpt("content", message?.optString("content")?.takeIf { it.isNotBlank() })
            .put("tool_calls", toolCalls)
    }

    private fun clarificationCardFromLeakedToolText(text: String): ClarificationCard? {
        val compact = text.lowercase().replace(Regex("[^a-z0-9]"), "")
        if (!compact.contains("askclarifyingquestion")) {
            return null
        }
        val question = Regex("""question\s*=\s*["']([^"']{1,160})["']""", RegexOption.IGNORE_CASE)
            .find(text)
            ?.groupValues
            ?.getOrNull(1)
            ?.trim()
            ?: return null
        val optionsText = Regex("""options\s*=\s*\[([\s\S]{1,400}?)]""", RegexOption.IGNORE_CASE)
            .find(text)
            ?.groupValues
            ?.getOrNull(1)
            ?: return null
        val options = Regex("""["']([^"']{1,64})["']""")
            .findAll(optionsText)
            .map { it.groupValues[1].trim() }
            .filter { it.isNotBlank() }
            .distinct()
            .take(3)
            .toList()
        if (options.isEmpty()) {
            return null
        }
        return ClarificationCard(
            question = question.take(120),
            context = "",
            options = options,
        )
    }

    private fun maybeClarificationCardFromText(text: String, prompt: String): ClarificationCard? {
        val normalized = text.trim()
        if (normalized.isBlank()) {
            return null
        }
        val question = extractUserFacingQuestion(normalized) ?: return null
        val optionLines = normalized
            .lineSequence()
            .map { it.trim() }
            .mapNotNull { line ->
                Regex("""^(?:[-*+•‣◦]|\d+[.)]|[A-Da-d][.)])\s+(.+)$""").find(line)?.groupValues?.getOrNull(1)?.trim()
            }
            .map { it.trim().trimEnd('.') }
            .filter { it.isNotBlank() }
            .map { it.take(64) }
            .distinct()
            .take(3)
            .toList()
        val options = when {
            optionLines.size >= 2 -> optionLines
            question.lowercase().contains("direction") ||
                question.lowercase().contains("navigate") ||
                question.lowercase().contains("map") -> listOf("Directions", "Not now")
            question.lowercase().startsWith("do ") ||
                question.lowercase().startsWith("would ") ||
                question.lowercase().startsWith("should ") ||
                question.lowercase().startsWith("can ") -> listOf("Yes", "No")
            else -> optionLines
        }
        return ClarificationCard(
            question = question,
            context = prompt.trim().take(180),
            options = options,
        )
    }

    private fun extractUserFacingQuestion(text: String): String? {
        val lines = text.lineSequence().map { it.trim() }.filter { it.isNotBlank() }.toList()
        val questionLine = lines.filter { it.contains("?") }.lastOrNull()
            ?: lines.lastOrNull { line ->
                Regex("""\b(do you want|would you like|want me to|should i|can i|need directions|ask for directions)\b""", RegexOption.IGNORE_CASE)
                    .containsMatchIn(line)
            }
            ?: return null
        val question = if (questionLine.contains("?")) {
            questionLine.substringBeforeLast("?").trim().plus("?")
        } else {
            questionLine.trim().trimEnd('.', ':').plus("?")
        }.take(120)
        val lower = question.lowercase()
        val directQuestion = listOf(
            "which ",
            "what ",
            "when ",
            "where ",
            "who ",
            "how ",
            "do you ",
            "would you ",
            "should i ",
            "could you ",
            "can you ",
            "please clarify",
            "clarify",
            "choose ",
            "select ",
            "want ",
            "need ",
        ).any { it in lower }
        return if (directQuestion || text.trimEnd().endsWith("?")) question else null
    }

    private fun systemMessage(): JSONObject {
        return JSONObject()
            .put("role", "system")
            .put("content", SYSTEM_INSTRUCTION + " " + localTimeInstruction())
    }

    private fun localTimeInstruction(): String {
        val now = ZonedDateTime.now()
        return "The Android phone local time is ${DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(now)}. " +
            "The Android timezone is ${now.zone.id}. Interpret relative dates using this timezone unless the user explicitly names another timezone."
    }

    private fun normalizeApiKey(apiKey: String): String {
        return apiKey.filterNot { it.isWhitespace() }
    }

    private fun ChatResult.Passed.isUsable(): Boolean {
        val message = extractMessage(raw) ?: return false
        return message.optString("content").isNotBlank() || message.optJSONArray("tool_calls") != null
    }

    private fun shouldTryNextModel(reason: String): Boolean {
        val text = reason.lowercase()
        return "429" in text ||
            "500" in text ||
            "502" in text ||
            "503" in text ||
            "504" in text ||
            "empty answer" in text ||
            "overloaded" in text ||
            "unavailable" in text ||
            "timed out" in text ||
            "timeout" in text
    }

    companion object {
        const val DEFAULT_MODEL = "glm-5.3-flash"
        private val MODEL_CANDIDATES = listOf(DEFAULT_MODEL, "deepseek-v4.1-flash")
        private const val CHAT_COMPLETIONS_URL = "https://opencode.ai/inference/go/v1/chat/completions"
        private const val MAX_ERROR_LENGTH = 220
        private const val MAX_OUTPUT_TOKENS = 2048
        private const val MAX_TOOL_ITERATIONS = 4
        private const val REQUEST_TIMEOUT_MS = 45_000
        private const val USER_AGENT = "BettyCompanion/0.1 (Android companion)"
        private val SESSION_ID: String = UUID.randomUUID().toString()
        private const val SYSTEM_INSTRUCTION =
            "You are Betty, a concise assistant answering on a Pebble watch. " +
                "Only watch-facing final replies should be compact: usually 2-4 short watch lines. Avoid vague one-line answers. Use fragments when they are clear. " +
                "Use Pebble-safe formatting only for text that will be displayed on the watch: short lines, line breaks, and '- ' bullets. Do not use markdown asterisks, code fences, tables, headings, citations, or long lists in watch-facing final text unless the user asks. " +
                "Do not apply watch brevity to content that will be written into another app or file. For tool arguments that create or update Google Docs, Gmail messages, Drive files, Sheets, Slides, Forms, drafts, notes, or other off-watch artifacts, write the full requested content in the tool argument: essays should have real paragraphs, emails should have full body text, and documents should not be outlines or summaries unless the user asked for an outline or summary. After the tool completes, summarize the result briefly for the watch. " +
                "Betty may include a durable user profile and memory block from Betty Companion. Treat it as the user's local Betty memory and use it when relevant. Do not invent profile facts. An OpenCode API key does not include consumer Gemini app memories, so use only the provided profile block, conversation context, and tool results for personal knowledge. If the user asks what Betty knows or remembers about them, call get_billy_user_profile. If the user explicitly asks Betty to remember/save a durable personal fact, or clearly corrects a durable profile fact, call remember_billy_user_fact. If the user asks Betty to forget/delete a memory, call forget_billy_user_fact. " +
                "Never ask the user an open-ended question in final text. If you need any user answer or decision, call ask_clarifying_question and provide 1-3 short likely options; the watch automatically adds Dictate for answers not listed. This includes yes/no questions, missing details, ambiguous choices, and follow-up questions. Ask only one question at a time. Do not end a normal text answer with a question. " +
                "When the request is ambiguous and a wrong guess could create, change, delete, message, navigate, spend time, or use private data incorrectly, call ask_clarifying_question instead of guessing. Prefer clarification for missing event time, calendar/account, reminder date, contact/person, destination, app/service, or which private result the user means. Do not ask if a safe default is obvious. Do not offer notes as a clarification option unless the user explicitly asks for Keep or notes. " +
                "For weather, local forecast, umbrella, temperature, wind, or weather-card requests, call get_weather; do not claim Betty lacks local weather data unless the tool says location permission is missing. Translate numbers into plain human guidance. For Calendar and Tasks, list useful names and times, not just counts. For photo analysis, mention concrete visible details. " +
                "Silently correct likely dictation errors. " +
                "For open-web image requests, use show_web_image_search; do not search Drive unless the user asks for their Drive files. For nearest, nearby, near me, closest, local, or around me place requests, call find_nearby_google_places first. For requests near home, my house, work, a hotel, an address, or another origin that is not the phone's current location, use find_google_places_near_address with the saved/profile origin text; if no concrete origin is available, ask one picker question for current location or dictated address. For simple place discovery such as 'coffee shop near my house', find places first; do not ask travel mode until the user asks for directions, navigation, route, travel time, or a map preview. Use included_type when clear, such as train_station for train/Amtrak stations, transit_station for transit stops, airport for airports, restaurant for restaurants, cafe for coffee, gas_station for gas, pharmacy for pharmacies, and hotel for hotels. Before any Maps route, directions, or navigation tool call, infer the user's intended travel mode semantically and pass the canonical travel_mode enum: DRIVE, WALK, BICYCLE, TRANSIT, or TWO_WHEELER. Do not omit travel_mode when the user implies a non-driving mode. For navigation to a nearby place, pass the selected nearby result label/name/address and travel_mode to open_maps_directions, then pass the same result name/address, destination_latitude, destination_longitude, and travel_mode to show_map_directions; do not geocode a selected result when coordinates are already available. For a specific destination navigation request, call open_maps_directions with the user's destination text and travel_mode first, then call show_map_directions with the same travel_mode and the destination coordinates if known or destination text if not. For route summaries, travel-time questions, or how-to-get-there reasoning, call get_google_route with the same travel_mode. For map-card-only or preview-map requests, call show_map_directions and do not open phone navigation. `show_map_directions` can create an OpenStreetMap card when no Maps key is configured. Google Maps Platform tools such as nearby search, routes, geocoding, and time-zone lookup require a Maps key; if one of those returns needs_api_key, say that briefly instead of pretending. If a Maps key is configured and a Google Maps Platform call fails, report the failure instead of substituting OpenStreetMap. " +
                "Use the provided companion tools for private phone or Google-synced data when relevant. " +
                "Calendar reads should prefer Google Calendar API results when available; Android Calendar Provider is fallback and may contain local ghosts. For calendar creation, call create_calendar_event with title/start/end. If the user names a calendar in words such as personal, primary, work, family, or an account email, pass that phrase as calendar_hint; do not list calendars first. If the destination calendar is unclear, omit calendar_id and calendar_hint so the tool can ask with a picker. Set create_meet_link=true when the user asks for a meeting link, video call, Google Meet, or conference call. For availability, free/busy, or scheduling options, use query_calendar_freebusy or find_calendar_availability before answering. Do not answer a create-event request by merely listing calendars. If the user asks to remove Betty/Bobby ghost calendar events, use delete_billy_calendar_ghosts. Photo tools access local/selected Android photos when permission is granted. For photo requests with dates like yesterday, Tuesday, last week, last month, or this day last year, pass both taken_after_millis and taken_before_millis as a closed local-time range; never represent a day/week/month request with only a lower bound. Use media_type=photo for camera-roll photos and screenshot only when explicitly requested. " +
                "For explicit Google Photos, Google Photos API, Photos Library, cloud/account photos, or Photos Picker requests, use search_google_photos_library or show_google_photos_picker_selection instead of local camera-roll tools. If using Google Photos Library categories, pass explicit supported category names in content_categories. Be honest: the current Google Photos Library API is generally app-created-only and cannot perform full consumer Google Photos semantic/person/place search; the Picker API only exposes photos the user selected in Google Photos. " +
                "Google Calendar, Tasks, Gmail, Drive, Contacts, Docs, Sheets, Slides, and Forms tools may use Google OAuth grants from the Android companion. " +
                "Google Keep personal OAuth is not available here. If the user asks for Keep, state briefly that Google restricts Keep API access for personal OAuth and do not create a Google Doc, Task, email draft, or other substitute unless the user explicitly asks for that substitute. " +
                "For Google Tasks requests, use create_google_task for new tasks, list_google_tasks for reads, and complete_google_task for complete/mark done/check off requests. Do not satisfy a completion request by listing tasks. " +
                "For Drive requests, prefer search_google_drive or list_recent_google_drive_files. For Docs, Sheets, Slides, and Forms, use read_google_doc, read_google_sheet, read_google_slides, or read_google_form when the user asks to read, summarize, find inside, or inspect content. Use create_google_doc, create_google_sheet, or create_google_slides only when the user explicitly asks to create those file types. For an existing Google Doc, if the user asks to edit, rewrite, expand, flesh out, continue, fix, replace, or append to the document, use update_google_doc. If current content matters, call read_google_doc first, then call update_google_doc with the complete new body for replace_body or the full appended text for append. If recent/current Google Doc context includes a document id, pass it as file_id. Do not satisfy an edit request by listing Drive files or by only reading the Doc back. " +
                "For Gmail reads, prefer search_gmail. If the user asks to email/send a message, use prepare_gmail_send so the watch can confirm before sending. Use create_gmail_draft only when the user explicitly asks for a draft. If a recipient is a contact name rather than an email address, try Google Contacts resolution through prepare_gmail_send or resolve_google_contact_email before asking for the address. " +
                "When a calendar create tool succeeds, include the exact calendar name and account returned by the tool. " +
                "Some Android app tools can only open a draft or app screen on the phone; describe those as drafts, never as completed silent actions. " +
                "Use get_google_service_status when the user asks for a Google service that may not be implemented. " +
                "An OpenCode API key does not automatically inherit consumer Gemini Connected Apps access; if Gmail, Drive, Docs, Sheets, Slides, Keep, Tasks, or another service lacks a provided tool, say briefly whether it is draft-only, open-only, or needs OAuth. " +
                "For watch reminders, alarms, and timers, do not use Calendar; those are handled by the watch app."
    }
}

private data class OpenCodeToolCall(
    val id: String,
    val name: String,
    val args: JSONObject,
)

private sealed interface ChatResult {
    data class Passed(val raw: String) : ChatResult
    data class Failed(val reason: String) : ChatResult
}
