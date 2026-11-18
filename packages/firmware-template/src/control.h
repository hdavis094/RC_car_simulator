#pragma once
#include <cstdint>

namespace car {
constexpr uint32_t kFailsafeMs = 500;
enum class Mode { Manual, Auto };
enum class CommandType { Drive, Mode, Estop };
struct Actuation {
  float throttle = 0;
  float steer = 0;
};
struct Command {
  CommandType type = CommandType::Estop;
  uint32_t seq = 0;
  Actuation drive;
  Mode mode = Mode::Manual;
};
struct ControlState {
  Mode mode = Mode::Manual;
  bool estop = false;
  bool hasSequence = false;
  bool hasDrive = false;
  bool failsafeTripped = false;
  uint32_t sequence = 0;
  uint32_t lastDriveMs = 0;
  Actuation manual;
};
bool sequenceNewer(uint32_t seq, uint32_t last);
bool failsafeDue(const ControlState& state, uint32_t nowMs);
ControlState updateSafety(ControlState state, uint32_t nowMs);
bool armingComplete(bool complete, uint32_t startedMs, uint32_t nowMs, uint32_t durationMs);
ControlState applyCommand(ControlState state, const Command& command, uint32_t nowMs);
ControlState newConnection(ControlState state);
Actuation output(const ControlState& state, uint32_t nowMs, bool armed, Actuation automatic);
int pulseUs(float value, int minimum, int neutral, int maximum);
}  // namespace car
