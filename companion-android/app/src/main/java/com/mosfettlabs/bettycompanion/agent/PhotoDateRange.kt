package com.mosfettlabs.bettycompanion.agent

internal data class PhotoDateRange(
    val label: String,
    val startMillis: Long,
    val endMillis: Long,
    val matchedText: String,
)
