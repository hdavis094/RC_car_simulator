#include "control_input.h"

#include <doctest.h>

#include <algorithm>
#include <string>

#include "avoidance.h"

namespace {
struct Reader {
  std::string text;
  size_t position = 0;
  int available() const { return static_cast<int>(text.size() - position); }
  int read() { return position < text.size() ? static_cast<unsigned char>(text[position++]) : -1; }
};
}  // namespace
using namespace car;
TEST_CASE("one outer loop handles junk followed by e-stop without draining the flood") {
  Reader reader{std::string(256, '\n') + "{\"t\":\"estop\"}\n" + std::string(5000, '\n')};
  ControlInput input;
  ControlState state;
  state.mode = Mode::Auto;
  Actuation applied{0.28F, 0};
  size_t steps = 0, commands = 0;
  // The same outer scheduler and slice parser are used by main.cpp. Each step
  // represents the real sensor/avoid/output update between serviceControl calls.
  runControlPasses(
      [&](size_t budget) {
        const size_t start = reader.position;
        const size_t consumed = input.readSlice(reader, budget, [&](const Command& command) {
          CHECK(steps == 32);  // 256 junk lines / 8 per slice, with 32 control steps.
          CHECK(command.type == CommandType::Estop);
          CHECK(reader.available() > 0);  // Do not wait for the rest of the flood.
          state = applyCommand(state, command, 100);
          applied = output(state, 100, true, {0.28F, 0});
          CHECK(applied.throttle == 0);
          ++commands;
        });
        CHECK(consumed <= kControlSliceBytes);
        CHECK(std::count(reader.text.begin() + start, reader.text.begin() + reader.position,
                         '\n') <= static_cast<int>(kControlSliceLines));
        return consumed;
      },
      [&] {
        state = updateSafety(state, 100);
        applied = output(state, 100, true, {0.28F, 0});
        ++steps;
      });
  CHECK(commands == 1);
  CHECK(state.estop);
  CHECK(applied.throttle == 0);
  CHECK(reader.position == kControlLoopBytes);
  CHECK(reader.available() > 0);
  CHECK(steps >= 33);
  CHECK_FALSE(input.takeRejected(999).any());
  CHECK(input.takeRejected(1000).invalid > 256);
  CHECK_FALSE(input.takeRejected(1000).any());
}
TEST_CASE("rejected-line summaries coalesce invalid and overlong lines at one Hz") {
  ControlInput input;
  Reader reader{std::string(256, '\n') + std::string(4096, 'x') + "\n"};
  while (reader.available()) {
    runControlPasses(
        [&](size_t budget) {
          return input.readSlice(reader, budget,
                                 [](const Command&) { FAIL("no valid commands expected"); });
        },
        [] {});
  }
  CHECK_FALSE(input.takeRejected(999).any());
  const auto summary = input.takeRejected(1000);
  CHECK(summary.invalid == 256);
  CHECK(summary.overlong == 1);
  reader.text += "{\"t\":\"unknown\"}\n";
  input.readSlice(reader, kControlSliceBytes, [](const Command&) { FAIL("unknown command"); });
  CHECK_FALSE(input.takeRejected(1999).any());
  CHECK(input.takeRejected(2000).invalid == 1);
  CHECK_FALSE(input.takeRejected(3000).any());
}
TEST_CASE("partial lines are discarded when a new controller connects") {
  ControlInput input;
  Reader old{"{\"t\":\"drive\""}, next{"{\"t\":\"estop\"}\n"};
  input.readSlice(old, kControlSliceBytes, [](const Command&) { FAIL("partial command"); });
  input.resetConnection();
  size_t applied = 0;
  input.readSlice(next, kControlSliceBytes, [&](const Command& command) {
    CHECK(command.type == CommandType::Estop);
    ++applied;
  });
  CHECK(applied == 1);
}
