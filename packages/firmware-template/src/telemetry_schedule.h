#pragma once
#include <cstdint>

namespace car {
// Control protocol cadence: 20 Hz, anchored to boot rather than the last send.
// Poll with explicit uptime. Missed periods are skipped, never replayed in a
// catch-up burst that could delay control work. Every deadline stays on phase.
class TelemetrySchedule {
 public:
  static constexpr uint32_t kPeriodMs = 50;
  explicit TelemetrySchedule(uint32_t originMs = 0) : nextMs_(originMs + kPeriodMs) {}
  bool take(uint32_t nowMs) {
    const uint32_t lateness = nowMs - nextMs_;
    if (lateness >= 0x80000000U) return false;
    nextMs_ += (lateness / kPeriodMs + 1) * kPeriodMs;
    return true;
  }

 private:
  uint32_t nextMs_;
};
}  // namespace car
