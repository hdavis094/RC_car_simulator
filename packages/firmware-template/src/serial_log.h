#pragma once
#include <array>
#include <cstdint>
#include <cstring>
#include <type_traits>
#include <utility>

namespace car {
template <typename T, typename = void>
struct HasSerialCapacity : std::false_type {};
template <typename T>
struct HasSerialCapacity<T, std::void_t<decltype(std::declval<T&>().availableForWrite())>>
    : std::true_type {};

// This firmware is the only UART writer. Reserve the complete CRLF line before
// its single write; never wait for the TX ring/FIFO to drain.
// https://github.com/espressif/arduino-esp32/blob/3.2.1/cores/esp32/HardwareSerial.cpp#L519-L521
// https://github.com/espressif/arduino-esp32/blob/3.2.1/cores/esp32/esp32-hal-uart.c#L989-L1001
template <typename SerialPort>
bool trySerialLine(SerialPort& serial, const char* message) {
  std::array<uint8_t, 192> bytes{};
  const size_t length = std::strlen(message);
  const size_t size = length + 2;
  if (size > bytes.size()) return false;
  if constexpr (HasSerialCapacity<SerialPort>::value) {
    const int available = serial.availableForWrite();
    if (available < 0 || static_cast<size_t>(available) < size) return false;
  } else {
#if defined(ARDUINO_ARCH_ESP32)
    static_assert(HasSerialCapacity<SerialPort>::value, "Board Serial requires a capacity query");
#else
    // Local fallback pending HAL's HardwareSerial::availableForWrite() mirror.
    // HAL captures bytes rather than waiting on a UART (arduino.cpp:73-76).
    // Bounded lines + coalesced/rate-limited logs stay below its 16 KiB tick cap.
#endif
  }
  std::memcpy(bytes.data(), message, length);
  bytes[length] = '\r';
  bytes[length + 1] = '\n';
  return serial.write(bytes.data(), size) == size;
}
}  // namespace car
