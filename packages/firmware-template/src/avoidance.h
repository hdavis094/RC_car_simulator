#pragma once
#include <array>
#include <cstdint>

#include "control.h"

namespace car {
struct Distance {
  uint16_t mm = 0;  // Zero means no target in range, never a timeout.
  bool valid = false;
};
struct AvoidanceTuning {
  float cruiseThrottle;
  float slowThrottle;
  float reverseThrottle;
  uint16_t slowMm;
  uint16_t blockedMm;
  uint16_t sideMm;
  float steerGain;
  uint32_t stopMs;
  uint32_t reverseMs;
};
struct AvoidanceState {
  bool blocked = false;
  uint32_t blockedSinceMs = 0;
};
struct AvoidanceDecision {
  AvoidanceState state;
  Actuation drive;
};
AvoidanceDecision avoid(AvoidanceState state, const std::array<Distance, 3>& distances,
                        uint32_t nowMs, const AvoidanceTuning& tuning);
}  // namespace car
