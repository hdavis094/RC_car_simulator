#include "control.h"

#include <algorithm>
#include <cmath>

namespace car {
bool sequenceNewer(uint32_t seq, uint32_t last) {
  const uint32_t delta = seq - last;
  return delta != 0 && delta <= 0x80000000U;
}
bool failsafeDue(const ControlState& state, uint32_t nowMs) {
  return state.mode == Mode::Manual && uint32_t(nowMs - state.lastDriveMs) >= kFailsafeMs;
}
ControlState applyCommand(ControlState state, const Command& command, uint32_t nowMs) {
  switch (command.type) {
    case CommandType::Drive:
      if (state.mode == Mode::Manual && !state.estop &&
          (!state.hasSequence || sequenceNewer(command.seq, state.sequence))) {
        state.hasSequence = true;
        state.sequence = command.seq;
        state.lastDriveMs = nowMs;
        state.manual = command.drive;
      }
      break;
    case CommandType::Mode:
      state.mode = command.mode;
      state.estop = false;
      break;
    case CommandType::Estop:
      state.estop = true;
      break;
  }
  return state;
}
ControlState newConnection(ControlState state) {
  state.hasSequence = false;
  return state;
}
Actuation output(const ControlState& state, uint32_t nowMs, bool armed, Actuation automatic) {
  if (!armed || state.estop || failsafeDue(state, nowMs)) return {};
  return state.mode == Mode::Auto ? automatic : state.manual;
}
int pulseUs(float value, int minimum, int neutral, int maximum) {
  value = std::clamp(value, -1.0F, 1.0F);
  return neutral +
         static_cast<int>(std::lround(value * (value < 0 ? neutral - minimum : maximum - neutral)));
}
}  // namespace car
