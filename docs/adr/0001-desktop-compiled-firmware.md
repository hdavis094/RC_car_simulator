# Firmware is compiled for the desktop against a simulated HAL

The user's Arduino sketch is compiled with the system C++ compiler (GCC or Clang on Linux, Apple clang on macOS) against `hal`, our implementation of the Arduino/ESP32 API, and runs as a native process that talks to `sim-core`. The same unmodified source builds for the real ESP32 with PlatformIO. Emulating the real ESP32 binary (Espressif's QEMU fork with peripheral models) would be more faithful, but peripheral and Wi-Fi emulation is a years-long effort that stays incomplete. A desktop build is buildable now, debuggable with normal tools, and keeps one codebase.

## Consequences

Bugs that come from the real chip (timing jitter, memory limits, interrupt races, FreeRTOS behaviour) don't show up in the sim. Hardware-in-the-loop is the planned answer for those. `hal` supports only the API surface the catalog parts need, and grows with the catalog.
