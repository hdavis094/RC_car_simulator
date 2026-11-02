#pragma once

#include <ArduinoJson.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace rcsim::hal {
using Bytes = std::vector<uint8_t>;
struct ProtocolError : std::runtime_error {
  using std::runtime_error::runtime_error;
};
JsonDocument decode(const Bytes& frame);
Bytes encode(const JsonDocument& message);
JsonDocument receive(int fd);
void send(int fd, const JsonDocument& message);
// Both peers must use a short /tmp path, independently of TMPDIR.
bool validSocketPath(const std::string& path);
}  // namespace rcsim::hal
