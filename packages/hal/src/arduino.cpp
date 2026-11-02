#include "Arduino.h"

#include <array>
#include <cstdarg>
#include <cstdio>
#include <vector>

#include "rcsim/runtime.h"

using rcsim::hal::runtime;
HardwareSerial Serial;
String::String(double value, unsigned char digits) {
  int n = std::snprintf(nullptr, 0, "%.*f", std::min<int>(digits, 20), value);
  if (n > 0) {
    std::vector<char> b(static_cast<size_t>(n) + 1);
    std::snprintf(b.data(), b.size(), "%.*f", std::min<int>(digits, 20), value);
    assign(b.data(), static_cast<size_t>(n));
  }
}
void String::trim() {
  auto first = find_first_not_of(" \t\r\n");
  if (first == npos) {
    clear();
    return;
  }
  auto last = find_last_not_of(" \t\r\n");
  *this = substr(first, last - first + 1);
}
size_t Print::printf(const char* format, ...) {
  va_list args, copy;
  va_start(args, format);
  va_copy(copy, args);
  int n = std::vsnprintf(nullptr, 0, format, copy);
  va_end(copy);
  if (n < 0) {
    va_end(args);
    return 0;
  }
  std::vector<char> b(static_cast<size_t>(n) + 1);
  std::vsnprintf(b.data(), b.size(), format, args);
  va_end(args);
  return write(reinterpret_cast<const uint8_t*>(b.data()), static_cast<size_t>(n));
}
int Stream::read(uint8_t* buffer, size_t size) {
  size_t n = 0;
  while (n < size) {
    int c = read();
    if (c < 0) break;
    buffer[n++] = static_cast<uint8_t>(c);
  }
  return static_cast<int>(n);
}
size_t Stream::readBytes(char* buffer, size_t size) {
  auto start = millis();
  size_t n = 0;
  while (n < size && static_cast<uint32_t>(millis() - start) < timeoutMs_) {
    int c = read();
    if (c >= 0) buffer[n++] = static_cast<char>(c);
  }
  return n;
}
String Stream::readStringUntil(char terminator) {
  String out;
  auto start = millis();
  while (static_cast<uint32_t>(millis() - start) < timeoutMs_) {
    int c = read();
    if (c == terminator) break;
    if (c >= 0) out += static_cast<char>(c);
  }
  return out;
}
void HardwareSerial::begin(unsigned long) { runtime().call(); }
size_t HardwareSerial::write(const uint8_t* data, size_t size) {
  runtime().call();
  runtime().serial(data, size);
  return size;
}
int HardwareSerial::available() {
  runtime().call();
  return static_cast<int>(runtime().serialRx().size());
}
int HardwareSerial::read() {
  runtime().call();
  auto& q = runtime().serialRx();
  if (q.empty()) return -1;
  int b = q.front();
  q.pop_front();
  return b;
}
int HardwareSerial::peek() {
  runtime().call();
  auto& q = runtime().serialRx();
  return q.empty() ? -1 : q.front();
}
void pinMode(uint8_t pin, uint8_t mode) {
  runtime().call();
  runtime().mode(pin, mode);
}
void digitalWrite(uint8_t pin, uint8_t value) {
  runtime().call();
  runtime().write(pin, value != LOW);
}
int digitalRead(uint8_t pin) {
  runtime().call();
  return runtime().read(pin) ? HIGH : LOW;
}
namespace {
float volts(uint8_t pin) {
  auto& r = runtime();
  for (size_t d = 0; d < r.deviceCount(); ++d) {
    if (r.config()["devices"][d]["kind"] != "analog") continue;
    for (auto p : r.config()["devices"][d]["pins"].as<JsonArrayConst>())
      if (p["gpio"] == pin) return constrain(r.reading(d)["volts"].as<float>(), 0.0F, 3.3F);
  }
  return 0;
}
struct Ledc {
  uint32_t frequency = 0;
  uint8_t resolution = 0;
};
std::array<Ledc, 256> channels;
}  // namespace
uint16_t analogRead(uint8_t pin) {
  runtime().call();
  return static_cast<uint16_t>(std::lround(volts(pin) * 4095 / 3.3));
}
uint32_t analogReadMilliVolts(uint8_t pin) {
  runtime().call();
  return static_cast<uint32_t>(std::lround(volts(pin) * 1000));
}
unsigned long millis() {
  runtime().call();
  return static_cast<uint32_t>(runtime().uptimeNs() / 1000000);
}
unsigned long micros() {
  runtime().call();
  return static_cast<uint32_t>(runtime().uptimeNs() / 1000);
}
void delay(unsigned long ms) { runtime().advance(uint64_t(ms) * 1000000); }
void delayMicroseconds(unsigned int us) { runtime().advance(uint64_t(us) * 1000); }
void yield() { runtime().call(); }
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout) {
  auto& r = runtime();
  r.call();
  uint64_t deadline = r.nowNs() + uint64_t(timeout) * 1000;
  auto wait = [&](bool level) {
    while (r.read(pin) == level) {
      if (r.nowNs() >= deadline) return false;
      r.advance(std::min<uint64_t>(1000, deadline - r.nowNs()));
    }
    return true;
  };
  bool high = state != LOW;
  if (!wait(high) || !wait(!high)) return 0;
  auto start = r.nowNs();
  if (!wait(high)) return 0;
  return static_cast<unsigned long>((r.nowNs() - start) / 1000);
}
bool ledcAttach(uint8_t pin, uint32_t frequency, uint8_t resolution) {
  runtime().call();
  if (!frequency || frequency > 1000000 || !resolution || resolution > 20) return false;
  channels[pin] = {frequency, resolution};
  runtime().pwm(pin, 1000000 / frequency, 0);
  return true;
}
bool ledcWrite(uint8_t pin, uint32_t duty) {
  runtime().call();
  auto c = channels[pin];
  if (!c.frequency) return false;
  uint32_t maximum = (1U << c.resolution) - 1;
  auto period = 1000000 / c.frequency;
  runtime().pwm(pin, period,
                static_cast<uint32_t>(uint64_t(std::min(duty, maximum)) * period / maximum));
  return true;
}
bool ledcDetach(uint8_t pin) {
  runtime().call();
  if (!channels[pin].frequency) return false;
  channels[pin] = {};
  runtime().pwm(pin, 0, 0);
  return true;
}
long map(long value, long inMin, long inMax, long outMin, long outMax) {
  runtime().call();
  return inMax == inMin ? outMin : (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}
