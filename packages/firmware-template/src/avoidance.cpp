#include "avoidance.h"

#include <algorithm>

namespace car {
AvoidanceDecision avoid(AvoidanceState state, const std::array<Distance, 3>& distances,
                        uint32_t nowMs, const AvoidanceTuning& tuning) {
  for (const auto& distance : distances) {
    // A failed sensor provides no safe direction in which to reverse.
    if (!distance.valid) return {{}, {}};
  }
  auto range = [](Distance distance) { return distance.mm == 0 ? 65535 : int(distance.mm); };
  const int left = range(distances[0]), centre = range(distances[1]), right = range(distances[2]);
  const float turn = left < right ? 1.0F : -1.0F;
  if (centre <= tuning.blockedMm) {
    if (!state.blocked) state = {true, nowMs};
    const uint32_t phase =
        uint32_t(nowMs - state.blockedSinceMs) % (tuning.stopMs + tuning.reverseMs);
    return {state, phase < tuning.stopMs ? Actuation{} : Actuation{tuning.reverseThrottle, -turn}};
  }
  const int nearer = std::min(left, right);
  const float steer =
      nearer < tuning.sideMm
          ? turn * std::clamp((tuning.sideMm - nearer) * tuning.steerGain, 0.0F, 1.0F)
          : 0.0F;
  const float fraction = std::clamp(
      float(centre - tuning.blockedMm) / float(tuning.slowMm - tuning.blockedMm), 0.0F, 1.0F);
  return {{},
          {tuning.slowThrottle + fraction * (tuning.cruiseThrottle - tuning.slowThrottle), steer}};
}
}  // namespace car
