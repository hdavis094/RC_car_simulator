#include "outbound.h"

#include <doctest.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <string>

#include "control.h"
#include "socket_helpers.h"

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
  for (int fd : sockets) {
    socket_test::nonblocking(fd);
    socket_test::smallBuffers(fd);
  }
  std::string filler(1024, 'x');
  size_t queued = 0;
  bool full = false;
  // Capacity can vary by OS: bound attempts AND bytes rather than waiting
  // indefinitely for EAGAIN. The receiver is never drained during this fill.
  for (size_t attempts = 0; attempts < 1024 && queued < 1024 * 1024; ++attempts) {
    const auto n = ::send(sockets[0], filler.data(), filler.size(), socket_test::sendFlags());
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && socket_test::wouldBlock()) {
      full = true;
      break;
    }
    REQUIRE_MESSAGE(n > 0, "fill failed; errno=", errno);
    queued += static_cast<size_t>(n);
  }
  REQUIRE_MESSAGE(full, "socket did not fill within 1 MiB / 1024 attempts");
  JsonDocument message;
  message["t"] = "telemetry";
  JsonDocument greeting;
  greeting["t"] = "hello";
  bool helloPending = true;
  auto hello = [&] {
    return sendDocument(
        greeting, [] {},
        [&](const uint8_t* bytes, size_t size) { return trySendSocket(sockets[0], bytes, size); });
  };
  helloPending = retryHello(helloPending, hello);
  CHECK(helloPending);
  helloPending = retryHello(helloPending, hello);
  CHECK(helloPending);
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
  // Loaded macOS runners have headroom; blocking retry regressions take seconds.
  CHECK(std::chrono::steady_clock::now() - start < std::chrono::seconds(1));
  size_t received = 0;
  for (size_t attempts = 0; received < queued && attempts < 1024; ++attempts) {
    char bytes[4096];
    const auto n =
        ::recv(sockets[1], bytes, std::min(sizeof(bytes), queued - received), MSG_DONTWAIT);
    if (n < 0 && errno == EINTR) continue;
    REQUIRE_MESSAGE(n > 0, "drain failed; errno=", errno);
    received += static_cast<size_t>(n);
  }
  REQUIRE(received == queued);
  char extra;
  REQUIRE(::recv(sockets[1], &extra, 1, MSG_DONTWAIT) < 0);
  REQUIRE(socket_test::wouldBlock());  // No prefix of a dropped line reached the peer.
  helloPending = retryHello(helloPending, hello);
  REQUIRE_FALSE(helloPending);  // Abort here if no hello was sent; never wait in recv.
  helloPending = retryHello(helloPending, [] {
    FAIL("a sent hello must not be repeated");
    return SendResult::Sent;
  });
  CHECK_FALSE(helloPending);
  char bytes[128];
  const auto n = ::recv(sockets[1], bytes, sizeof(bytes), MSG_DONTWAIT);
  REQUIRE(n > 0);
  CHECK(std::string(bytes, static_cast<size_t>(n)) == "{\"t\":\"hello\"}\n");
}
TEST_CASE("socket send treats memory exhaustion as a dropped message, and peer closure as fatal") {
  CHECK(socketSendResult(-1, 10, ENOMEM) == SendResult::Dropped);
  CHECK(socketSendResult(-1, 10, ENOBUFS) == SendResult::Dropped);
  CHECK(socketSendResult(-1, 10, EPIPE) == SendResult::Disconnect);
  CHECK(socketSendResult(5, 10, 0) == SendResult::Disconnect);
  int sockets[2];
  REQUIRE(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  struct Cleanup {
    int fd;
    ~Cleanup() { ::close(fd); }
  } cleanup{sockets[0]};
  socket_test::nonblocking(sockets[0]);
  socket_test::nonblocking(sockets[1]);
  REQUIRE(::close(sockets[1]) == 0);
  const uint8_t bytes[] = {'x', '\n'};
  CHECK(trySendSocket(sockets[0], bytes, sizeof(bytes)) == SendResult::Disconnect);
  CHECK(errno == EPIPE);
}
TEST_CASE("socket fd bounds are rejected before FD_SET can access them") {
  const uint8_t bytes[] = {'x', '\n'};
  CHECK(trySendSocket(-1, bytes, sizeof(bytes)) == SendResult::Dropped);
  CHECK(trySendSocket(FD_SETSIZE, bytes, sizeof(bytes)) == SendResult::Dropped);
  CHECK(trySendSocket(FD_SETSIZE + 1, bytes, sizeof(bytes)) == SendResult::Dropped);
}
