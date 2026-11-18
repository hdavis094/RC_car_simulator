#include "avoidance.h"

#include <doctest.h>

using namespace car;
namespace {
constexpr AvoidanceTuning tuning{0.28F, 0.12F, -0.18F, 900, 250, 700, 1.0F / 450, 300, 600};
std::array<Distance, 3> ranges(uint16_t left, uint16_t centre, uint16_t right) {
  return {{{left, true}, {centre, true}, {right, true}}};
}
}  // namespace
TEST_CASE("clear path cruises and no target is distinct from timeout") {
  for (auto distance : {ranges(1200, 1200, 1200), ranges(0, 0, 0)}) {
    auto d = avoid({}, distance, 0, tuning);
    CHECK(d.drive.throttle == doctest::Approx(tuning.cruiseThrottle));
    CHECK(d.drive.steer == 0);
    CHECK_FALSE(d.state.blocked);
  }
  for (int i = 0; i < 3; ++i) {
    auto distance = ranges(1200, 1200, 1200);
    distance[i].valid = false;
    auto d = avoid({true, 0}, distance, 500, tuning);
    CHECK(d.drive.throttle == 0);
    CHECK(d.drive.steer == 0);
  }
}
TEST_CASE("steers away from the nearer side and slows as the centre closes") {
  CHECK(avoid({}, ranges(300, 1200, 1000), 0, tuning).drive.steer > 0);
  CHECK(avoid({}, ranges(1000, 1200, 300), 0, tuning).drive.steer < 0);
  CHECK(avoid({}, ranges(0, 1200, 300), 0, tuning).drive.steer < 0);
  auto far = avoid({}, ranges(1000, 850, 1000), 0, tuning);
  auto near = avoid({}, ranges(1000, 350, 1000), 0, tuning);
  CHECK(near.drive.throttle > 0);
  CHECK(near.drive.throttle < far.drive.throttle);
}
TEST_CASE("blocked path stops then reverses with opposite steering, wraps and recovers") {
  for (uint32_t start : {0U, 0xffffff00U}) {
    for (bool leftNear : {true, false}) {
      auto distance = leftNear ? ranges(100, 250, 700) : ranges(700, 250, 100);
      auto d = avoid({}, distance, start, tuning);
      CHECK(d.state.blocked);
      CHECK(d.drive.throttle == 0);
      CHECK(avoid(d.state, distance, start + 299, tuning).drive.throttle == 0);
      auto reverse = avoid(d.state, distance, start + 300, tuning);
      CHECK(reverse.drive.throttle < 0);
      CHECK((reverse.drive.steer < 0) == leftNear);
      CHECK(avoid(d.state, distance, start + 899, tuning).drive.throttle < 0);
      CHECK(avoid(d.state, distance, start + 900, tuning).drive.throttle == 0);
      auto recovered = avoid(d.state, ranges(1200, 1200, 1200), start + 901, tuning);
      CHECK_FALSE(recovered.state.blocked);
      CHECK(recovered.drive.throttle > 0);
    }
  }
}
