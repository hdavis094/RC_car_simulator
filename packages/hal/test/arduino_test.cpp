#include "Arduino.h"

#include <limits>

#include "fake_sim.h"

using namespace rcsim::hal;
using hal_test::FakeSim;
TEST_CASE("delay carries across hundreds of STEP boundaries without extra call costs") {
  FakeSim sim;
  sim.start();
  for (int i = 0; i < 3; ++i) {
    auto before = runtime().nowNs();
    delay(100);
    CHECK(runtime().nowNs() - before == 100000000);
    runtime().loopReturned();
    CHECK(runtime().nowNs() - before == 100005000);
  }
  CHECK(sim.done.size() == 300);
  for (size_t i = 0; i < sim.done.size(); ++i) CHECK(sim.done[i]["message"]["tick"] == i);
  auto before = runtime().nowNs();
  delayMicroseconds(123);
  CHECK(runtime().nowNs() - before == 123000);
}
TEST_CASE("millis busy wait terminates and nanosecond remainders are preserved") {
  FakeSim sim;
  sim.config["message"]["halCallCostNs"] = 333;
  sim.start();
  auto t = millis();
  while (millis() - t < 50) {
  }
  CHECK(runtime().uptimeNs() >= 50000000);
  CHECK(runtime().uptimeNs() < 50000333);
  CHECK(sim.done.size() == 50);
  CHECK(runtime().uptimeNs() % 333 == 0);
}
TEST_CASE("firmware uptime restarts at a nonzero run tick") {
  auto config = hal_test::load("../sim-protocol/vectors/config-no-devices.json");
  config["message"]["halCallCostNs"] = 1000;
  auto first = hal_test::makeStep(2500);
  runtime().start(config, first, [](const JsonDocument&) { return hal_test::makeStep(2501); });
  CHECK(micros() == 1);
  CHECK(millis() == 0);
}
TEST_CASE("GPIO edges produce a timestamped pulse across tick boundaries") {
  FakeSim sim;
  sim.prepare = [](JsonDocument& d) {
    auto tick = d["message"]["tick"].as<int>();
    if (tick == 0 || tick == 2) {
      auto e = d["message"]["gpioEdges"].as<JsonArray>().add<JsonObject>();
      e["gpio"] = 34;
      e["tUs"] = tick ? 2580 : 200;
      e["level"] = tick == 0;
    }
  };
  sim.start();
  CHECK(pulseIn(34, HIGH) == 2380);
  CHECK(pulseIn(34, HIGH, 100) == 0);
  pinMode(13, OUTPUT);
  digitalWrite(13, HIGH);
  delayMicroseconds(10);
  digitalWrite(13, LOW);
  delay(1);
  auto writes = sim.done.back()["message"]["gpioWrites"];
  REQUIRE(writes.size() == 2);
  CHECK(writes[1]["tUs"].as<uint64_t>() - writes[0]["tUs"].as<uint64_t>() == 11);
}
TEST_CASE("ADC, serial, String and numeric helpers work as firmware expects") {
  FakeSim sim;
  sim.prepare = [](JsonDocument& d) {
    if (d["message"]["tick"] == 0) {
      d["message"]["serialRx"].as<JsonArray>().add(65);
    }
  };
  sim.start();
  CHECK(analogRead(35) == 2559);
  CHECK(analogReadMilliVolts(35) == 2063);
  CHECK(analogRead(32) == 0);
  Serial.begin(115200);
  CHECK(Serial.available() == 1);
  CHECK(Serial.peek() == 65);
  CHECK(Serial.read() == 65);
  CHECK(Serial.read() == -1);
  Serial.print("x=");
  Serial.print(255, HEX);
  Serial.println();
  Serial.printf("%d", 42);
  delay(1);
  std::string text;
  auto serial = sim.done[0]["message"]["serialTx"].as<JsonArrayConst>();
  for (auto b : serial) text += static_cast<char>(b.as<uint8_t>());
  CHECK(text == "x=ff\r\n42");
  String s("  car  ");
  s.trim();
  CHECK(s == "car");
  CHECK(s.substring(1) == "ar");
  CHECK(String(-123) == "-123");
  CHECK(String(255, HEX) == "ff");
  CHECK(String(1.25, 2) == "1.25");
  CHECK(String(std::numeric_limits<int>::min()) == "-2147483648");
  CHECK(constrain(12, 0, 10) == 10);
  CHECK(map(90, 0, 180, 1000, 2000) == 1500);
}
TEST_CASE("LEDC records changed pulse widths and detach") {
  FakeSim sim;
  sim.start();
  CHECK_FALSE(ledcAttach(25, 0, 10));
  CHECK(ledcAttach(25, 50, 16));
  CHECK(ledcWrite(25, 4915));
  delay(1);
  auto pwm = sim.done[0]["message"]["pwm"];
  REQUIRE(pwm.size() == 1);
  CHECK(pwm[0]["periodUs"] == 20000);
  CHECK(pwm[0]["pulseUs"] == 1500);
  CHECK(ledcDetach(25));
  delay(1);
  CHECK(sim.done[1]["message"]["pwm"][0]["periodUs"] == 0);
}
TEST_CASE("invalid STEP ordering and BYE stop runtime cleanly") {
  FakeSim sim;
  sim.start();
  runtime().start(sim.config, hal_test::makeStep(0),
                  [](const JsonDocument&) { return hal_test::makeStep(2); });
  CHECK_THROWS_AS(delay(1), ProtocolError);
  runtime().start(sim.config, hal_test::makeStep(0), [](const JsonDocument&) {
    JsonDocument bye;
    bye["type"] = "BYE";
    bye["message"]["message"] = "done";
    return bye;
  });
  CHECK_THROWS_AS(delay(1), EndRun);
}

TEST_CASE("vendored ArduinoJson supports Arduino String inputs, outputs and conversions") {
  JsonDocument doc;
  String source("{\"mode\":\"manual\"}");
  REQUIRE_FALSE(deserializeJson(doc, source));
  CHECK(doc["mode"].as<String>() == "manual");
  doc["name"] = String("car");
  String output("replace this");
  CHECK(serializeJson(doc, output) > 0);
  CHECK(output == "{\"mode\":\"manual\",\"name\":\"car\"}");
  CHECK(String(true) == "1");
}
