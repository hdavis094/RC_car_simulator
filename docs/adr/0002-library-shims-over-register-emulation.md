# Sensor libraries are shimmed at the library API, not emulated at the register level

In sim builds, `hal` provides its own implementations of a pinned set of Arduino sensor libraries (`pololu/VL53L0X`, an MPU6050 library, `ESP32Servo`), with the same headers and API, fed by readings from `sim-core`. Register-level emulation behind a simulated `Wire` would let any library work, but the VL53L0X's register protocol, in particular, is large and mostly undocumented. Firmware has to use a supported library to run in the sim; each shim still models the behaviour firmware must handle, such as the VL53L0X boot address and XSHUT sequencing.

## Considered options

- **Register-level emulation for simple devices** (MPU6050) is cheap and can be added later without changing the protocol: readings arrive the same way.
