#include "rcsim/protocol.h"

#include <doctest.h>

#include <filesystem>
#include <fstream>
#include <iterator>

using namespace rcsim::hal;
TEST_CASE("all golden vectors agree in both directions and malformed vectors are rejected") {
  size_t good = 0, bad = 0;
  for (const auto& entry :
       std::filesystem::recursive_directory_iterator("../sim-protocol/vectors")) {
    if (entry.path().extension() != ".bin") continue;
    INFO(entry.path().string());
    std::ifstream input(entry.path(), std::ios::binary);
    Bytes bytes{std::istreambuf_iterator<char>(input), {}};
    if (entry.path().parent_path().filename() == "malformed") {
      CHECK_THROWS_AS(decode(bytes), ProtocolError);
      ++bad;
      continue;
    }
    auto path = entry.path();
    path.replace_extension(".json");
    std::ifstream json(path);
    JsonDocument expected;
    REQUIRE_FALSE(deserializeJson(expected, json));
    auto actual = decode(bytes);
    CHECK(actual.as<JsonVariantConst>() == expected.as<JsonVariantConst>());
    CHECK(encode(actual) == bytes);
    CHECK(encode(expected) == bytes);
    ++good;
  }
  CHECK(good == 17);
  CHECK(bad == 16);
}
TEST_CASE("socket paths are portable regardless of host temporary directory") {
  CHECK(validSocketPath("/tmp/rcsim-123-1.sock"));
  CHECK(validSocketPath("/tmp/" + std::string(94, 'a')));
  CHECK_FALSE(validSocketPath("/tmp/" + std::string(95, 'a')));
  CHECK_FALSE(validSocketPath("/var/folders/rcsim.sock"));
  CHECK_FALSE(validSocketPath(std::string("/tmp/a\0b", 8)));
}
TEST_CASE("encoder validates fields rather than narrowing invalid values") {
  JsonDocument doc;
  REQUIRE_FALSE(deserializeJson(
      doc, R"({"type":"HELLO","message":{"protocolVersion":65536,"halVersion":"x"}})"));
  CHECK_THROWS_AS(encode(doc), ProtocolError);
  doc["message"]["protocolVersion"] = 1;
  doc["message"]["halVersion"] = std::string(1025, 'a');
  CHECK_THROWS_AS(encode(doc), ProtocolError);
}
