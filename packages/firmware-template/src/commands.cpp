#include "commands.h"

#include <ArduinoJson.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace car {
namespace {
struct Reader {
  const char* text;
  size_t length, position = 0;
  int read() { return position < length ? static_cast<unsigned char>(text[position++]) : -1; }
  size_t readBytes(char* buffer, size_t count) {
    count = std::min(count, length - position);
    std::memcpy(buffer, text + position, count);
    position += count;
    return count;
  }
};
bool number(JsonVariantConst value) {
  return value.is<double>() && std::isfinite(value.as<double>());
}
}  // namespace
bool parseCommand(const char* text, size_t length, Command& command) {
  Reader reader{text, length};
  JsonDocument doc;
  if (deserializeJson(doc, reader, DeserializationOption::NestingLimit(16)) ||
      !doc.is<JsonObject>())
    return false;
  while (reader.position < length) {
    const char c = text[reader.position++];
    if (c != ' ' && c != '\t' && c != '\r' && c != '\n') return false;
  }
  auto object = doc.as<JsonObjectConst>();
  const char* type = object["t"].as<const char*>();
  if (!type) return false;
  Command parsed;
  if (std::strcmp(type, "drive") == 0) {
    if (!object["seq"].is<uint32_t>() || !number(object["throttle"]) || !number(object["steer"]))
      return false;
    parsed.type = CommandType::Drive;
    parsed.seq = object["seq"].as<uint32_t>();
    parsed.drive = {static_cast<float>(std::clamp(object["throttle"].as<double>(), -1.0, 1.0)),
                    static_cast<float>(std::clamp(object["steer"].as<double>(), -1.0, 1.0))};
  } else if (std::strcmp(type, "mode") == 0) {
    const char* mode = object["mode"].as<const char*>();
    if (!mode || (std::strcmp(mode, "manual") != 0 && std::strcmp(mode, "auto") != 0)) return false;
    parsed.type = CommandType::Mode;
    parsed.mode = std::strcmp(mode, "auto") == 0 ? Mode::Auto : Mode::Manual;
  } else if (std::strcmp(type, "estop") == 0) {
    parsed.type = CommandType::Estop;
  } else {
    return false;
  }
  command = parsed;
  return true;
}
CommandLine::Result CommandLine::push(char byte) {
  if (complete_) reset();
  if (byte == '\n') {
    complete_ = true;
    if (discard_) return Result::TooLong;
    if (size_ && bytes_[size_ - 1] == '\r') --size_;
    return Result::Ready;
  }
  if (size_ == bytes_.size() - 1) discard_ = true;
  if (!discard_) bytes_[size_++] = byte;
  return Result::Pending;
}
void CommandLine::reset() {
  size_ = 0;
  discard_ = false;
  complete_ = false;
}
}  // namespace car
