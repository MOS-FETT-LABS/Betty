package com.mosfettlabs.bettycompanion.settings

data class CompanionSettings(
    val geminiApiKey: String = "",
    val googleMapsApiKey: String = "",
    val googleClientId: String = "",
    val pebbleBridgeEnabled: Boolean = true,
)
