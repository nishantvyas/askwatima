idf_component_register(
    SRCS
        "main.cpp"
        "ui.cpp"
        "audio.cpp"
        "battery.cpp"
        "net.cpp"
        "wifi.cpp"
        "config.cpp"
        "provision.cpp"
        "ota.cpp"
    INCLUDE_DIRS "."
    # The default idle image ships inside the app rather than in a data
    # partition, so a device shows something the first time it is switched on -
    # before it has network, an owner, or any chance to fetch one. A parent's
    # upload later overrides it from SPIFFS; this is the floor, not the feature.
    EMBED_FILES "idle-default.jpg"
    REQUIRES
        port_bsp
        codec_board
        my_button
        lvgl
        esp_wifi
        esp_netif
        esp_event
        esp_http_server
        nvs_flash
        esp-tls
        esp_http_client
        esp_https_ota
        app_update
        esp_timer
        mbedtls
        driver)
