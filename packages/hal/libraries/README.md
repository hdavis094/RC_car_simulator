# Portable libraries

`ArduinoJson/ArduinoJson.h` is the unmodified single header for [ArduinoJson 7.4.2](https://github.com/bblanchon/ArduinoJson/releases/tag/v7.4.2), vendored from that release's `ArduinoJson-v7.4.2.h` asset. Its MIT licence is beside the header. No download is needed to build firmware. The header SHA-256 is `a05ac98f4481d2398c103ca5ffcce8e2fcd7fa2fa1d8d9f38d5757454f448d97`.

Both the HAL and `bin/build-sim` add this directory as a system include path. Firmware includes `<ArduinoJson.h>` and uses the same ArduinoJson 7 API as its PlatformIO build. The native `String`, `Print`, and `Stream` surfaces also support ArduinoJson's readers, writers and string conversions.
