#include "commands.h"

#include <doctest.h>

#include <string>

using namespace car;
TEST_CASE("commands accept required fields, clamp numbers and ignore extensions") {
  Command command;
  auto parse = [&](const std::string& text) {
    return parseCommand(text.data(), text.size(), command);
  };
  REQUIRE(parse(R"({"t":"drive","seq":4294967295,"throttle":12,"steer":-2,"extension":{}})"));
  CHECK(command.type == CommandType::Drive);
  CHECK(command.seq == 0xffffffffU);
  CHECK(command.drive.throttle == 1);
  CHECK(command.drive.steer == -1);
  REQUIRE(parse(R"({"t":"mode","mode":"auto"})"));
  CHECK(command.type == CommandType::Mode);
  CHECK(command.mode == Mode::Auto);
  REQUIRE(parse(R"({"t":"mode","mode":"manual"})"));
  CHECK(command.mode == Mode::Manual);
  REQUIRE(parse("{\"t\":\"estop\"}\r\n"));
  CHECK(command.type == CommandType::Estop);
}
TEST_CASE("invalid commands never mutate the destination or accept a second JSON value") {
  Command command{CommandType::Drive, 42, {0.25F, 0}, Mode::Auto};
  for (const std::string text : {"",
                                 "[]",
                                 "null",
                                 "3",
                                 "{",
                                 "{}",
                                 R"({"t":7})",
                                 R"({"t":"unknown"})",
                                 R"({"t":"mode"})",
                                 R"({"t":"mode","mode":"AUTO"})",
                                 R"({"t":"drive","throttle":0,"steer":0})",
                                 R"({"t":"drive","seq":-1,"throttle":0,"steer":0})",
                                 R"({"t":"drive","seq":4294967296,"throttle":0,"steer":0})",
                                 R"({"t":"drive","seq":1.5,"throttle":0,"steer":0})",
                                 R"({"t":"drive","seq":true,"throttle":0,"steer":0})",
                                 R"({"t":"drive","seq":1,"throttle":"1","steer":0})",
                                 R"({"t":"drive","seq":1,"throttle":true,"steer":0})",
                                 R"({"t":"drive","seq":1,"throttle":null,"steer":0})",
                                 R"({"t":"drive","seq":1,"throttle":1e999,"steer":0})",
                                 R"({"t":"drive","seq":1,"throttle":0})",
                                 R"({"t":"estop"} garbage)",
                                 R"({"t":"estop"}{"t":"mode","mode":"auto"})"}) {
    INFO(text);
    CHECK_FALSE(parseCommand(text.data(), text.size(), command));
    CHECK(command.seq == 42);
    CHECK(command.type == CommandType::Drive);
  }
}
TEST_CASE("line framing handles fragments, CRLF, the exact wire limit, and recovery") {
  CommandLine line;
  for (char byte : std::string("{\"t\":\"estop\"}\r"))
    CHECK(line.push(byte) == CommandLine::Result::Pending);
  CHECK(line.push('\n') == CommandLine::Result::Ready);
  CHECK(std::string(line.data(), line.size()) == R"({"t":"estop"})");
  for (int i = 0; i < 4095; ++i) CHECK(line.push(' ') == CommandLine::Result::Pending);
  CHECK(line.push('\n') == CommandLine::Result::Ready);
  CHECK(line.size() == 4095);
  for (int i = 0; i < 4095; ++i) line.push(' ');
  line.push('\r');  // CR counts toward the on-wire limit too.
  CHECK(line.push('\n') == CommandLine::Result::TooLong);
  for (int i = 0; i < 12000; ++i) line.push('x');
  CHECK(line.push('\n') == CommandLine::Result::TooLong);
  for (char byte : std::string("{\"t\":\"estop\"}")) line.push(byte);
  CHECK(line.push('\n') == CommandLine::Result::Ready);
  Command command;
  CHECK(parseCommand(line.data(), line.size(), command));
  line.push('{');
  line.reset();  // New connection discards a previous client's incomplete line.
  CHECK(line.size() == 0);
}
