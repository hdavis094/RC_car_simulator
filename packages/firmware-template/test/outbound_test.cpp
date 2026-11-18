#include "outbound.h"

#include <doctest.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <string>

#include "control.h"

using namespace car;
TEST_CASE("outbound frames include LF in one send attempt, or drop whole when oversized") {
  JsonDocument document;
  document["t"] = "hello";
  int updates = 0, sends = 0;
  CHECK(sendDocument(
            document, [&] { ++updates; },
            [&](const uint8_t* bytes, size_t size) {
              CHECK(updates == 1);
              ++sends;
              CHECK(std::string(reinterpret_cast<const char*>(bytes), size) ==
                    "{\"t\":\"hello\"}\n");
              return SendResult::Dropped;
            }) == SendResult::Dropped);
  CHECK(sends == 1);  // Never retry an unsuccessful attempt.
  document["msg"] = std::string(kOutboundBytes, 'x');
  CHECK(sendDocument(
            document, [&] { ++updates; },
            [&](const uint8_t*, size_t) {
              ++sends;
              return SendResult::Sent;
            }) == SendResult::Dropped);
  CHECK(updates == 2);
  CHECK(sends == 1);
}
TEST_CASE("a full socket cannot delay the output update, failsafe or e-stop") {
  int sockets[2];
  REQUIRE(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  struct Cleanup {
    int a, b;
    ~Cleanup() {
      ::close(a);
      ::close(b);
    }
  } cleanup{sockets[0], sockets[1]};
  int limit = 4096;
  REQUIRE(setsockopt(sockets[0], SOL_SOCKET, SO_SNDBUF, &limit, sizeof(limit)) == 0);
  std::string filler(4096, 'x');
  size_t queued = 0;
  while (true) {
    const auto n = ::send(sockets[0], filler.data(), filler.size(), MSG_DONTWAIT);
    if (n < 0) {
      REQUIRE((errno == EAGAIN || errno == EWOULDBLOCK));
      break;
    }
    REQUIRE(n > 0);
    queued += static_cast<size_t>(n);
  }
  JsonDocument message;
  message["t"] = "telemetry";
  const Command drive{CommandType::Drive, 1, {0.4F, -0.2F}, Mode::Manual};
  auto state = applyCommand({}, drive, 0);
  Actuation applied;
  bool updated = false;
  auto sender = [&](const uint8_t* bytes, size_t size) {
    CHECK(updated);
    updated = false;
    return trySendSocket(sockets[0], bytes, size);
  };
  const auto start = std::chrono::steady_clock::now();
  for (uint32_t now = 0; now <= 501; ++now) {
    const auto result = sendDocument(
        message,
        [&] {
          state = updateSafety(state, now);
          applied = output(state, now, true, {});
          updated = true;
        },
        sender);
    CHECK(result == SendResult::Dropped);
    if (now == 499) CHECK(applied.throttle == doctest::Approx(0.4));
    if (now >= 500) CHECK(applied.throttle == 0);
  }
  CHECK(state.failsafeTripped);
  state = applyCommand(state, Command{CommandType::Drive, 2, {0.4F, 0}, Mode::Manual}, 600);
  state = applyCommand(state, Command{}, 601);
  CHECK(sendDocument(
            message,
            [&] {
              state = updateSafety(state, 601);
              applied = output(state, 601, true, {});
              updated = true;
            },
            sender) == SendResult::Dropped);
  CHECK(applied.throttle == 0);
  // A regression to NetworkClient's 1 s select/retry loop violates this bound.
  CHECK(std::chrono::steady_clock::now() - start < std::chrono::milliseconds(250));
  size_t received = 0;
  while (true) {
    char bytes[4096];
    const auto n = ::recv(sockets[1], bytes, sizeof(bytes), MSG_DONTWAIT);
    if (n < 0) break;
    REQUIRE(n > 0);
    received += static_cast<size_t>(n);
  }
  CHECK(received == queued);  // No prefix of a dropped line reached the peer.
  CHECK(sendDocument(
            message, [] {},
            [&](const uint8_t* bytes, size_t size) {
              return trySendSocket(sockets[0], bytes, size);
            }) == SendResult::Sent);
  char bytes[128];
  const auto n = ::recv(sockets[1], bytes, sizeof(bytes), 0);
  REQUIRE(n > 0);
  CHECK(std::string(bytes, static_cast<size_t>(n)) == "{\"t\":\"telemetry\"}\n");
}
