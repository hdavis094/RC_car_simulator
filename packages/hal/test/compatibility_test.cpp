#include <type_traits>

#include "Arduino.h"
#include "WiFi.h"
#include "fake_sim.h"

using hal_test::FakeSim;
using rcsim::hal::runtime;
static_assert(!std::is_convertible_v<HardwareSerial, bool>);
static_assert(!std::is_convertible_v<WiFiClient, bool>);
static_assert(std::is_same_v<decltype(constrain(1, -1.5f, 1.5f)), float>);
TEST_CASE("Print accepts IPAddress and character buffers through Serial and clients") {
  FakeSim sim;
  sim.start();
  WiFi.begin();
  CHECK(Serial.println(WiFi.localIP()) == 11);
  char data[] = {'a', '\0', 'b'};
  CHECK(Serial.write(data, sizeof(data)) == 3);
  WiFiClient client;
  CHECK(client.write(data, sizeof(data)) == 0);
  CHECK(static_cast<bool>(Serial));
  CHECK_FALSE(static_cast<bool>(client));
  delay(1);
  std::string text;
  auto bytes = sim.done[0]["message"]["serialTx"].as<JsonArrayConst>();
  for (auto b : bytes) text.push_back(static_cast<char>(b.as<uint8_t>()));
  CHECK(text == std::string("127.0.0.1\r\na\0b", 14));
}
TEST_CASE("String concatenates Arduino numeric types as text and edits characters") {
  String text("a");
  text += 5;
  text += -2;
  text += 3U;
  text += 4L;
  text += 5UL;
  text += 1.25f;
  CHECK(text == "a5-23451.25");
  CHECK(text.concat(-7));
  CHECK(text.concat(8U));
  CHECK(text.concat(9L));
  CHECK(text.concat(10UL));
  CHECK(text.concat(2.5f));
  CHECK(text == "a5-23451.25-789102.50");
  text = "abca";
  text.replace('a', 'x');
  CHECK(text == "xbcx");
  text.replace("x", "yz");
  CHECK(text == "yzbcyz");
  text.replace("", "ignored");
  CHECK(text == "yzbcyz");
  CHECK(text.charAt(0) == 'y');
  CHECK(text.charAt(100) == '\0');
  text.toUpperCase();
  CHECK(text == "YZBCYZ");
  text.toLowerCase();
  CHECK(text == "yzbcyz");
}
TEST_CASE("Stream parses integers and reads String with simulated timeouts") {
  FakeSim sim;
  sim.prepare = [](JsonDocument& d) {
    if (d["message"]["tick"] == 0)
      for (char c : std::string("ignore -12,345 tail"))
        d["message"]["serialRx"].as<JsonArray>().add(static_cast<uint8_t>(c));
  };
  sim.start();
  Serial.begin(115200, SERIAL_8N1);
  Serial.setTimeout(2);
  CHECK(Serial.parseInt(SKIP_ALL, ',') == -12345);
  CHECK(Serial.readString() == " tail");
  CHECK(Serial.parseInt() == 0);
  CHECK(runtime().uptimeNs() >= 4000000);
}
TEST_CASE("core helpers use common types, configured ADC depth and PWM") {
  FakeSim sim;
  sim.start();
  CHECK(constrain(2, -1.5f, 1.5f) == 1.5f);
  CHECK(constrain(-2, -1.5f, 1.5f) == -1.5f);
  CHECK(radians(90) == doctest::Approx(HALF_PI));
  CHECK(sq(3.5) == 12.25);
  CHECK(LED_BUILTIN == 2);
  analogReadResolution(10);
  CHECK(analogRead(35) == 639);
  analogReadResolution(12);
  CHECK(analogRead(35) == 2559);
  analogWrite(25, 128);
  delay(1);
  auto pwm = sim.done.back()["message"]["pwm"];
  REQUIRE(pwm.size() == 1);
  CHECK(pwm[0]["periodUs"] == 1000);
  CHECK(pwm[0]["pulseUs"] == 502);
}
TEST_CASE("Arduino random is repeatable from the session seed and explicit reseeding") {
  FakeSim sim;
  sim.start();
  std::vector<long> first;
  for (int i = 0; i < 20; ++i) first.push_back(random(-100, 100));
  sim.start();
  for (auto expected : first) CHECK(random(-100, 100) == expected);
  sim.config["message"]["seed"] = 42;
  sim.start();
  std::vector<long> other;
  for (int i = 0; i < 20; ++i) {
    auto value = random(-100, 100);
    CHECK(value >= -100);
    CHECK(value < 100);
    other.push_back(value);
  }
  CHECK(first != other);
  randomSeed(123);
  auto value = random(100000);
  randomSeed(123);
  CHECK(random(100000) == value);
  CHECK(random(0) == 0);
  CHECK(random(5, 5) == 5);
}
