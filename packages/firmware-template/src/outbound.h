#pragma once
#include <ArduinoJson.h>

#include <array>
#include <cstddef>
#include <cstdint>

namespace car {
// Smaller than lwIP's TCP_SNDLOWAT, checked against the board's actual config.
constexpr size_t kOutboundBytes = 512;
enum class SendResult { Sent, Dropped, Disconnect };
SendResult trySendSocket(int fd, const uint8_t* bytes, size_t size);

// Sender must make one bounded, nonblocking attempt; never retry a partial line.
// Updating PWM is mandatory even if the message is oversized or cannot be sent.
template <typename UpdateOutputs, typename Sender>
SendResult sendDocument(const JsonDocument& document, UpdateOutputs updateOutputs, Sender sender) {
  updateOutputs();
  std::array<uint8_t, kOutboundBytes> bytes{};
  const size_t length = measureJson(document);
  if (length + 1 > bytes.size()) return SendResult::Dropped;
  if (serializeJson(document, bytes.data(), length) != length) return SendResult::Dropped;
  bytes[length] = '\n';
  return sender(bytes.data(), length + 1);
}
}  // namespace car
