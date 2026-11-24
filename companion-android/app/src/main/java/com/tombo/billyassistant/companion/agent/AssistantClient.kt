package com.tombo.billyassistant.companion.agent

import com.tombo.billyassistant.companion.agent.tools.CompanionToolExecution
import com.tombo.billyassistant.companion.agent.tools.WatchImage
import org.json.JSONArray
import org.json.JSONObject

/**
 * Provider-agnostic assistant client. Implemented by GeminiClient (legacy) and
 * OpenCodeClient (Betty default). The public surface mirrors the original
 * GeminiClient so call sites only swap types.
 */
interface AssistantClient {
    fun describeConfiguration(apiKey: String): String
    fun createRequest(prompt: String, apiKey: String): GeminiRequestPlan
    fun testKey(apiKey: String): GeminiKeyTestResult
    fun generateText(prompt: String, apiKey: String): GeminiTextResult
    fun chooseImageCandidate(
        prompt: String,
        apiKey: String,
        candidates: List<GeminiImageCandidate>,
    ): GeminiImageChoice?

    fun generateWithTools(
        prompt: String,
        apiKey: String,
        toolDeclarations: JSONArray,
        toolExecutor: (String, JSONObject) -> CompanionToolExecution,
    ): CompanionAgentResult
}

data class WatchImageUnused(val unused: WatchImage? = null)
