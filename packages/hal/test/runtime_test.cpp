#include <chrono>

#include "Arduino.h"
#include "fake_sim.h"

using namespace rcsim::hal;
TEST_CASE("full serial frames build and encode within a fraction of the stall timeout") {
  hal_test::FakeSim sim;
  sim.start();
  Bytes bytes(16384);
  for (size_t i = 0; i < bytes.size(); ++i) bytes[i] = static_cast<uint8_t>(i);
  auto start = std::chrono::steady_clock::now();
  runtime().serial(bytes.data(), bytes.size());
  delay(1);
  auto elapsed = std::chrono::steady_clock::now() - start;
  INFO("serial frame build/encode milliseconds: "
       << std::chrono::duration<double, std::milli>(elapsed).count());
  CHECK(elapsed < std::chrono::milliseconds(250));
  auto serial = sim.done[0]["message"]["serialTx"].as<JsonArrayConst>();
  REQUIRE(serial.size() == bytes.size());
  Bytes actual;
  for (auto b : serial) actual.push_back(b.as<uint8_t>());
  CHECK(actual == bytes);
  // The next byte must flush a full frame and start the next one.
  sim.start();
  runtime().serial(bytes.data(), bytes.size());
  runtime().serial(bytes.data(), 1);
  delay(1);
  REQUIRE(sim.done.size() == 2);
  CHECK(sim.done[0]["message"]["serialTx"].size() == 16384);
  CHECK(sim.done[1]["message"]["serialTx"].size() == 1);
}
