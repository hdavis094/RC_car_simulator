#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <type_traits>

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x01
#define OUTPUT 0x03
#define INPUT_PULLUP 0x05
#define INPUT_PULLDOWN 0x09
#define OUTPUT_OPEN_DRAIN 0x13
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2
#define PROGMEM
#define F(s) (s)
constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180;
constexpr double RAD_TO_DEG = 180 / PI;
using byte = uint8_t;
using boolean = bool;
using word = uint16_t;

class String : public std::string {
 public:
  using std::string::append;
  using std::string::string;
  String& append(const char* s) {
    std::string::append(s);
    return *this;
  }
  String() = default;
  String(const char* s) : std::string(s ? s : "") {}
  String(const std::string& s) : std::string(s) {}
  String(char c) : std::string(1, c) {}
  explicit String(double value, unsigned char digits = 2);
  template <typename T,
            std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, char>, int> = 0>
  explicit String(T value, unsigned char base = 10) : std::string(number(value, base)) {}
  unsigned int length() const { return static_cast<unsigned int>(size()); }
  bool isEmpty() const { return empty(); }
  bool concat(const char* s) {
    append(s);
    return true;
  }
  bool concat(char c) {
    push_back(c);
    return true;
  }
  bool concat(const String& s) {
    append(s);
    return true;
  }
  bool concat(const char* s, size_t n) {
    append(s, n);
    return true;
  }
  bool equals(const String& s) const { return *this == s; }
  bool startsWith(const String& s) const { return rfind(s, 0) == 0; }
  bool endsWith(const String& s) const {
    return size() >= s.size() && compare(size() - s.size(), s.size(), s) == 0;
  }
  int indexOf(char c, unsigned int from = 0) const {
    auto n = find(c, from);
    return n == npos ? -1 : static_cast<int>(n);
  }
  int indexOf(const String& s, unsigned int from = 0) const {
    auto n = find(s, from);
    return n == npos ? -1 : static_cast<int>(n);
  }
  String substring(unsigned int from, unsigned int to) const {
    if (from > to) std::swap(from, to);
    return substr(std::min<size_t>(from, size()), to - from);
  }
  String substring(unsigned int from) const { return substr(std::min<size_t>(from, size())); }
  void remove(unsigned int from, unsigned int count = static_cast<unsigned int>(-1)) {
    if (from < size()) erase(from, count);
  }
  void trim();
  long toInt() const { return std::strtol(c_str(), nullptr, 10); }
  float toFloat() const { return std::strtof(c_str(), nullptr); }
  void toCharArray(char* out, unsigned int len) const {
    if (len) {
      auto n = std::min<size_t>(size(), len - 1);
      std::memcpy(out, data(), n);
      out[n] = 0;
    }
  }

 private:
  template <typename T>
  static std::string number(T value, unsigned char base) {
    if (base < 2 || base > 36) base = 10;
    using U = std::make_unsigned_t<std::conditional_t<std::is_same_v<T, bool>, unsigned int, T>>;
    bool negative = false;
    if constexpr (std::is_signed_v<T>) negative = base == 10 && value < 0;
    U n = negative ? U(0) - static_cast<U>(value) : static_cast<U>(value);
    std::string out;
    do {
      out.push_back("0123456789abcdefghijklmnopqrstuvwxyz"[n % base]);
      n /= base;
    } while (n);
    if (negative) out.push_back('-');
    std::reverse(out.begin(), out.end());
    return out;
  }
};
inline String operator+(const String& a, const String& b) {
  return String(static_cast<const std::string&>(a) + static_cast<const std::string&>(b));
}
inline String operator+(const String& a, const char* b) {
  return String(static_cast<const std::string&>(a) + b);
}
inline String operator+(const char* a, const String& b) {
  return String(a + static_cast<const std::string&>(b));
}

class Print {
 public:
  virtual ~Print() = default;
  virtual size_t write(const uint8_t* data, size_t size) = 0;
  size_t write(uint8_t b) { return write(&b, 1); }
  size_t write(const char* s) {
    return s ? write(reinterpret_cast<const uint8_t*>(s), std::strlen(s)) : 0;
  }
  size_t print(const String& s) {
    return write(reinterpret_cast<const uint8_t*>(s.data()), s.size());
  }
  size_t print(const char* s) { return write(s); }
  size_t print(char c) { return write(static_cast<uint8_t>(c)); }
  size_t print(double n, int digits = 2) {
    return print(String(n, static_cast<unsigned char>(digits)));
  }
  template <typename T, std::enable_if_t<std::is_integral_v<T>, int> = 0>
  size_t print(T n, int base = DEC) {
    return print(String(n, static_cast<unsigned char>(base)));
  }
  size_t println() { return write("\r\n"); }
  template <typename T>
  size_t println(const T& value) {
    auto n = print(value);
    return n + println();
  }
  template <typename T>
  size_t println(T value, int format) {
    auto n = print(value, format);
    return n + println();
  }
  size_t printf(const char* format, ...) __attribute__((format(printf, 2, 3)));
};
class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual void flush() {}
  int read(uint8_t* buffer, size_t size);
  size_t readBytes(char* buffer, size_t size);
  size_t readBytes(uint8_t* buffer, size_t size) {
    return readBytes(reinterpret_cast<char*>(buffer), size);
  }
  String readStringUntil(char terminator);
  void setTimeout(unsigned long ms) { timeoutMs_ = ms; }

 private:
  unsigned long timeoutMs_ = 1000;
};
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long baud);
  using Print::write;
  using Stream::read;
  size_t write(const uint8_t* data, size_t size) override;
  int available() override;
  int read() override;
  int peek() override;
  explicit operator bool() const { return true; }
};
extern HardwareSerial Serial;
void pinMode(uint8_t pin, uint8_t mode);
int digitalRead(uint8_t pin);
void digitalWrite(uint8_t pin, uint8_t value);
uint16_t analogRead(uint8_t pin);
uint32_t analogReadMilliVolts(uint8_t pin);
unsigned long millis();
unsigned long micros();
void delay(unsigned long ms);
void delayMicroseconds(unsigned int us);
unsigned long pulseIn(uint8_t pin, uint8_t state, unsigned long timeout = 1000000UL);
void yield();
bool ledcAttach(uint8_t pin, uint32_t frequency, uint8_t resolution);
bool ledcWrite(uint8_t pin, uint32_t duty);
bool ledcDetach(uint8_t pin);
long map(long value, long inMin, long inMax, long outMin, long outMax);
template <typename T, typename L, typename H>
constexpr T constrain(T value, L low, H high) {
  return value < low ? static_cast<T>(low) : value > high ? static_cast<T>(high) : value;
}
using std::max;
using std::min;
