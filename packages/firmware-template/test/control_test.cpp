#include "control.h"

#include <doctest.h>

#include <initializer_list>
#include <limits>

using namespace car;
namespace {
Command drive(uint32_t seq = 1) { return {CommandType::Drive, seq, {0.4F, -0.2F}, Mode::Manual}; }
Command mode(Mode mode) { return {CommandType::Mode, 0, {}, mode}; }
void neutral(Actuation value) {
  CHECK(value.throttle == 0);
  CHECK(value.steer == 0);
}
}  // namespace
TEST_CASE("manual drive expires at exactly 500 ms, including across millis wrap") {
  for (uint32_t start : {100U, std::numeric_limits<uint32_t>::max() - 100}) {
    auto state = applyCommand({}, drive(), start);
    CHECK(output(state, start + 499, true, {}).throttle == doctest::Approx(0.4));
    CHECK_FALSE(failsafeDue(state, start + 499));
    CHECK(failsafeDue(state, start + 500));
    neutral(output(state, start + 500, true, {}));
    state = applyCommand(state, drive(2), start + 900);
    CHECK_FALSE(failsafeDue(state, start + 900));
    CHECK(output(state, start + 900, true, {}).steer == doctest::Approx(-0.2));
  }
}
TEST_CASE("boot and arming are neutral; mode commands do not refresh the drive timer") {
  neutral(output({}, 0, true, {}));
  auto state = applyCommand({}, drive(), 10);
  neutral(output(state, 20, false, {1, 1}));
  state = applyCommand(state, mode(Mode::Auto), 400);
  CHECK(output(state, 1000, true, {0.3F, 1}).throttle == doctest::Approx(0.3));
  state = applyCommand(state, drive(2), 1000);
  CHECK(state.lastDriveMs == 10);
  state = applyCommand(state, mode(Mode::Manual), 1000);
  neutral(output(state, 1000, true, {}));
}
TEST_CASE("e-stop latches in either mode until mode clears it, ignoring drives") {
  for (Mode initial : {Mode::Manual, Mode::Auto}) {
    auto state = applyCommand({}, drive(), 10);
    state = applyCommand(state, mode(initial), 20);
    state = applyCommand(state, Command{}, 30);
    state = applyCommand(state, drive(2), 40);
    CHECK(state.estop);
    CHECK(state.lastDriveMs == 10);
    CHECK(state.sequence == 1);
    neutral(output(state, 40, true, {1, 1}));
    state = newConnection(state);
    CHECK(state.estop);
    state = applyCommand(state, mode(Mode::Manual), 600);
    CHECK_FALSE(state.estop);
    neutral(output(state, 600, true, {}));
    state = applyCommand(state, drive(0), 610);
    CHECK(output(state, 610, true, {}).throttle == doctest::Approx(0.4));
  }
}
TEST_CASE("sequence order wraps, includes half-range, and resets only with a new connection") {
  CHECK(sequenceNewer(0, 0xffffffffU));
  CHECK(sequenceNewer(0x80000000U, 0));
  CHECK_FALSE(sequenceNewer(0, 0));
  CHECK_FALSE(sequenceNewer(0xffffffffU, 0));
  CHECK_FALSE(sequenceNewer(0x80000001U, 0));
  auto state = applyCommand({}, drive(15), 1);
  for (auto seq : {15U, 14U, 13U}) state = applyCommand(state, drive(seq), 450);
  CHECK(state.lastDriveMs == 1);
  neutral(output(state, 501, true, {}));
  state = applyCommand(state, mode(Mode::Manual), 600);
  CHECK(state.hasSequence);
  state = applyCommand(newConnection(state), drive(0), 700);
  CHECK(state.lastDriveMs == 700);
}
TEST_CASE("normalized actuation maps to the default servo and ESC pulse ranges") {
  CHECK(pulseUs(-1, 1000, 1500, 2000) == 1000);
  CHECK(pulseUs(0, 1000, 1500, 2000) == 1500);
  CHECK(pulseUs(1, 1000, 1500, 2000) == 2000);
  CHECK(pulseUs(0.4F, 1000, 1500, 2000) == 1700);
  CHECK(pulseUs(-2, 1000, 1500, 2000) == 1000);
}
