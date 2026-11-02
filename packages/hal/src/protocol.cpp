#include "rcsim/protocol.h"

#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cmath>
#include <cstring>
#include <initializer_list>
#include <limits>

namespace rcsim::hal {
namespace {
constexpr uint64_t kSafe = 9007199254740991ULL;
constexpr size_t kFrame = 1048576;
void require(bool ok, const char* reason) {
  if (!ok) throw ProtocolError(reason);
}
bool utf8(const std::string& s) {
  size_t i = 0;
  while (i < s.size()) {
    uint8_t c = static_cast<uint8_t>(s[i++]);
    if (c < 128) continue;
    int n;
    uint32_t code, minimum;
    if (c >= 0xc2 && c <= 0xdf) {
      n = 1;
      code = c & 31;
      minimum = 128;
    } else if (c >= 0xe0 && c <= 0xef) {
      n = 2;
      code = c & 15;
      minimum = 2048;
    } else if (c >= 0xf0 && c <= 0xf4) {
      n = 3;
      code = c & 7;
      minimum = 65536;
    } else
      return false;
    while (n--) {
      if (i == s.size()) return false;
      uint8_t b = static_cast<uint8_t>(s[i++]);
      if ((b & 0xc0) != 0x80) return false;
      code = (code << 6) | (b & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
struct Codec {
  Bytes& bytes;
  bool reading;
  size_t pos = 0;
  uint64_t raw(uint64_t value, unsigned n) {
    if (reading) {
      require(pos + n <= bytes.size(), "truncated frame");
      value = 0;
      for (unsigned i = 0; i < n; ++i) value |= uint64_t(bytes[pos++]) << (i * 8);
    } else {
      for (unsigned i = 0; i < n; ++i) bytes.push_back(uint8_t(value >> (i * 8)));
    }
    return value;
  }
  template <typename V>
  uint64_t integer(V&& v, unsigned n, uint64_t maximum = kSafe) {
    if (!reading) require(v.template is<uint64_t>(), "expected unsigned integer");
    uint64_t value = reading ? 0 : v.template as<uint64_t>();
    value = raw(value, n);
    require(value <= maximum && (n == 8 || value < (uint64_t(1) << (n * 8))),
            "integer out of range");
    if (reading) v.set(value);
    return value;
  }
  template <typename V>
  void u8(V&& v) {
    integer(v, 1);
  }
  template <typename V>
  void u16(V&& v) {
    integer(v, 2);
  }
  template <typename V>
  void u32(V&& v) {
    integer(v, 4);
  }
  template <typename V>
  void u64(V&& v) {
    integer(v, 8);
  }
  template <typename V>
  void boolean(V&& v) {
    if (!reading) require(v.template is<bool>(), "expected bool");
    auto b = raw(v.template as<bool>() ? 1 : 0, 1);
    require(b <= 1, "invalid bool");
    if (reading) v.set(b != 0);
  }
  template <typename V>
  void f32(V&& v) {
    if (!reading) require(v.template is<double>(), "expected float");
    float f = v.template as<float>();
    uint32_t bits;
    std::memcpy(&bits, &f, 4);
    bits = static_cast<uint32_t>(raw(bits, 4));
    std::memcpy(&f, &bits, 4);
    require(std::isfinite(f), "nonfinite f32");
    if (reading) v.set(f);
  }
  template <typename V>
  void string(V&& v) {
    if (!reading) require(v.template is<std::string>(), "expected string");
    std::string s = v.template as<std::string>();
    size_t n = static_cast<size_t>(raw(reading ? 0 : s.size(), 2));
    require(n <= 1024, "string over limit");
    if (reading) {
      require(pos + n <= bytes.size(), "truncated string");
      s.assign(reinterpret_cast<const char*>(bytes.data() + pos), n);
      pos += n;
    } else
      bytes.insert(bytes.end(), s.begin(), s.end());
    require(utf8(s), "invalid UTF-8");
    if (reading) v.set(s);
  }
  template <typename V>
  unsigned enumeration(V&& v, std::initializer_list<const char*> names, unsigned base = 0) {
    unsigned code = base;
    if (!reading) {
      bool found = false;
      for (const char* name : names) {
        if (v == name) {
          found = true;
          break;
        }
        ++code;
      }
      require(found, "invalid enum");
    }
    code = static_cast<unsigned>(raw(code, 1));
    require(code >= base && code < base + names.size(), "invalid enum");
    if (reading) v.set(*(names.begin() + (code - base)));
    return code;
  }
  template <typename V, typename F>
  void array(V&& v, F element, size_t limit = 4096, unsigned countBytes = 2) {
    if (!reading) require(v.template is<JsonArray>(), "expected array");
    size_t n = static_cast<size_t>(raw(reading ? 0 : v.size(), countBytes));
    require(n <= limit, "array over limit");
    JsonArray a = reading ? v.template to<JsonArray>() : v.template as<JsonArray>();
    for (size_t i = 0; i < n; ++i) {
      if (reading) a.add(nullptr);
      element(a[i]);
    }
  }
  template <typename V>
  void vector3(V&& v) {
    if (reading) {
      auto a = v.template to<JsonArray>();
      for (int i = 0; i < 3; ++i) a.add(0);
    }
    require(v.template is<JsonArray>() && v.size() == 3, "expected vec3");
    for (int i = 0; i < 3; ++i) f32(v[i]);
  }
  void message(JsonDocument& doc) {
    auto type = enumeration(doc["type"], {"HELLO", "CONFIG", "STEP", "STEP_DONE", "BYE"}, 1);
    JsonVariant m = reading ? doc["message"].to<JsonVariant>() : doc["message"].as<JsonVariant>();
    switch (type) {
      case 1:
        u16(m["protocolVersion"]);
        string(m["halVersion"]);
        break;
      case 2:
        u16(m["protocolVersion"]);
        u32(m["tickUs"]);
        u32(m["seed"]);
        u32(m["halCallCostNs"]);
        u32(m["loopCostNs"]);
        string(m["net"]["bindAddress"]);
        array(m["devices"], [&](JsonVariant d) {
          string(d["instanceId"]);
          string(d["kind"]);
          array(d["pins"], [&](JsonVariant p) {
            string(p["name"]);
            u8(p["gpio"]);
          });
          u8(d["defaultI2cAddress"]);
          u8(d["targetI2cAddress"]);
        });
        break;
      case 3: {
        u64(m["tick"]);
        u64(m["t0Us"]);
        u64(m["t1Us"]);
        array(m["readings"], [&](JsonVariant r) {
          u16(r["device"]);
          u64(r["tUs"]);
          auto kind = enumeration(r["type"], {"distance", "imu", "analog"}, 1);
          if (kind == 1) {
            u16(r["mm"]);
            enumeration(r["status"], {"valid", "no-target", "signal-fail"});
          } else if (kind == 2) {
            vector3(r["accel"]);
            vector3(r["gyro"]);
            f32(r["tempC"]);
          } else
            f32(r["volts"]);
        });
        array(m["gpioEdges"], [&](JsonVariant e) {
          u8(e["gpio"]);
          u64(e["tUs"]);
          boolean(e["level"]);
        });
        array(m["serialRx"], [&](JsonVariant b) { u8(b); }, 16384, 4);
        auto present = raw(m["netFaults"].isNull() ? 0 : 1, 1);
        require(present <= 1, "invalid optional");
        if (present) {
          auto f = m["netFaults"];
          u32(f["latencyUs"]);
          integer(f["lossPpm"], 4, 1000000);
          boolean(f["dropout"]);
        }
        break;
      }
      case 4:
        u64(m["tick"]);
        array(m["pwm"], [&](JsonVariant p) {
          u8(p["gpio"]);
          u32(p["periodUs"]);
          u32(p["pulseUs"]);
        });
        array(m["gpioWrites"], [&](JsonVariant p) {
          u8(p["gpio"]);
          u64(p["tUs"]);
          boolean(p["level"]);
        });
        array(m["serialTx"], [&](JsonVariant b) { u8(b); }, 16384, 4);
        array(m["netEvents"], [&](JsonVariant e) {
          auto kind = enumeration(e["type"], {"listen", "unlisten", "connect", "disconnect"}, 1);
          if (kind <= 2) enumeration(e["proto"], {"tcp", "udp"});
          u16(e["firmwarePort"]);
          if (kind == 1) {
            u16(e["hostPort"]);
            string(e["bindAddress"]);
          } else if (kind >= 3)
            string(e["peer"]);
        });
        array(
            m["logs"],
            [&](JsonVariant l) {
              enumeration(l["level"], {"debug", "info", "warn", "error"});
              string(l["text"]);
            },
            256);
        break;
      case 5:
        enumeration(m["reason"], {"normal", "version-mismatch", "malformed", "stalled", "shutdown",
                                  "firmware-exit"});
        string(m["message"]);
        break;
    }
  }
};
void transfer(int fd, uint8_t* data, size_t size, bool writing) {
  while (size) {
    // Runtime ignores SIGPIPE; send/recv then report peer loss as an exception.
    ssize_t n = writing ? ::send(fd, data, size, 0) : ::recv(fd, data, size, 0);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) throw std::runtime_error("sim socket lost");
    data += n;
    size -= static_cast<size_t>(n);
  }
}
}  // namespace
JsonDocument decode(const Bytes& frame) {
  Bytes bytes = frame;
  Codec c{bytes, true};
  auto n = c.raw(0, 4);
  require(n >= 1 && n <= kFrame && n + 4 == bytes.size(), "invalid frame length");
  JsonDocument doc;
  c.message(doc);
  require(c.pos == bytes.size(), "trailing bytes");
  return doc;
}
Bytes encode(const JsonDocument& message) {
  Bytes bytes;
  JsonDocument doc = message;
  Codec c{bytes, false};
  c.raw(0, 4);
  c.message(doc);
  require(bytes.size() - 4 <= kFrame, "frame over limit");
  auto n = bytes.size() - 4;
  for (unsigned i = 0; i < 4; ++i) bytes[i] = uint8_t(n >> (8 * i));
  return bytes;
}
JsonDocument receive(int fd) {
  Bytes bytes(4);
  transfer(fd, bytes.data(), 4, false);
  uint32_t n = uint32_t(bytes[0]) | uint32_t(bytes[1]) << 8 | uint32_t(bytes[2]) << 16 |
               uint32_t(bytes[3]) << 24;
  require(n >= 1 && n <= kFrame, "invalid frame length");
  bytes.resize(n + 4);
  transfer(fd, bytes.data() + 4, n, false);
  return decode(bytes);
}
void send(int fd, const JsonDocument& message) {
  auto bytes = encode(message);
  transfer(fd, bytes.data(), bytes.size(), true);
}
bool validSocketPath(const std::string& path) {
  return path.rfind("/tmp/", 0) == 0 && path.size() < 100 && path.find('\0') == std::string::npos;
}
}  // namespace rcsim::hal
