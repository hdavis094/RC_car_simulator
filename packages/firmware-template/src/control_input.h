#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>

#include "commands.h"

namespace car {
constexpr size_t kControlSliceBytes = 256;
constexpr size_t kControlSliceLines = 8;
constexpr size_t kControlLoopBytes = 4096;
struct RejectedLines {
  uint32_t invalid = 0;
  uint32_t overlong = 0;
  bool any() const { return invalid || overlong; }
};
class ControlInput {
 public:
  void resetConnection() { line_.reset(); }
  template <typename Reader, typename Apply>
  size_t readSlice(Reader& reader, size_t byteBudget, Apply apply) {
    size_t bytes = 0, lines = 0;
    byteBudget = std::min(byteBudget, kControlSliceBytes);
    while (bytes < byteBudget && lines < kControlSliceLines && reader.available()) {
      const int byte = reader.read();
      if (byte < 0) break;
      ++bytes;
      const auto result = line_.push(static_cast<char>(byte));
      if (result == CommandLine::Result::Pending) continue;
      ++lines;
      if (result == CommandLine::Result::TooLong) {
        increment(rejected_.overlong);
      } else {
        Command command;
        if (parseCommand(line_.data(), line_.size(), command))
          apply(command);
        else
          increment(rejected_.invalid);
      }
    }
    return bytes;
  }
  RejectedLines takeRejected(uint32_t nowMs) {
    if (!rejected_.any() || uint32_t(nowMs - lastReportMs_) < 1000) return {};
    const auto result = rejected_;
    rejected_ = {};
    lastReportMs_ = nowMs;
    return result;
  }

 private:
  static void increment(uint32_t& count) {
    if (count != std::numeric_limits<uint32_t>::max()) ++count;
  }
  CommandLine line_;
  RejectedLines rejected_;
  uint32_t lastReportMs_ = 0;
};

// One outer loop handles a bounded burst, with sensors/avoidance/PWM between
// EVERY slice, even when the client continuously supplies malformed lines.
template <typename ReadSlice, typename ControlStep>
void runControlPasses(ReadSlice readSlice, ControlStep controlStep) {
  size_t budget = kControlLoopBytes;
  do {
    const size_t consumed = readSlice(budget);
    controlStep();
    if (!consumed) break;
    budget -= consumed;
  } while (budget);
}
}  // namespace car
