#pragma once
#include <array>
#include <cstddef>

#include "control.h"

namespace car {
bool parseCommand(const char* text, size_t length, Command& command);
// Includes CR and LF in the on-wire limit. A long line is discarded through LF.
class CommandLine {
 public:
  enum class Result { Pending, Ready, TooLong };
  Result push(char byte);
  const char* data() const { return bytes_.data(); }
  size_t size() const { return size_; }
  void reset();

 private:
  std::array<char, 4096> bytes_{};
  size_t size_ = 0;
  bool discard_ = false, complete_ = false;
};
}  // namespace car
