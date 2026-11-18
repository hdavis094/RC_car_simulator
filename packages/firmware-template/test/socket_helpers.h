#pragma once
#include <doctest.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdint>

namespace socket_test {
using Clock = std::chrono::steady_clock;
inline int sendFlags() {
  int flags = MSG_DONTWAIT;
#ifdef MSG_NOSIGNAL
  flags |= MSG_NOSIGNAL;
#endif
  return flags;
}
inline bool wouldBlock() { return errno == EAGAIN || errno == EWOULDBLOCK; }
inline void nonblocking(int fd) {
  REQUIRE(fd >= 0);
  const int flags = fcntl(fd, F_GETFL, 0);
  REQUIRE(flags >= 0);
  REQUIRE(fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0);
#ifdef SO_NOSIGPIPE
  int enabled = 1;
  REQUIRE(setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, sizeof(enabled)) == 0);
#endif
}
inline void waitReady(int fd, short events, Clock::time_point deadline) {
  while (true) {
    const auto left =
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now());
    REQUIRE_MESSAGE(left.count() > 0, "socket readiness deadline expired");
    pollfd p{fd, events, 0};
    const int result = ::poll(&p, 1, static_cast<int>(left.count()));
    if (result < 0 && errno == EINTR) continue;
    REQUIRE_MESSAGE(result == 1, "socket readiness failed; errno=", errno);
    REQUIRE((p.revents & (events | POLLERR | POLLHUP)) != 0);
    return;
  }
}
inline void transfer(int fd, uint8_t* bytes, size_t size, bool writing) {
  const auto deadline = Clock::now() + std::chrono::seconds(2);
  while (size) {
    REQUIRE(Clock::now() < deadline);
    const auto n =
        writing ? ::send(fd, bytes, size, sendFlags()) : ::recv(fd, bytes, size, MSG_DONTWAIT);
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && wouldBlock()) {
      waitReady(fd, writing ? POLLOUT : POLLIN, deadline);
      continue;
    }
    REQUIRE_MESSAGE(n > 0, "socket transfer failed; errno=", errno);
    bytes += n;
    size -= static_cast<size_t>(n);
  }
}
inline void smallBuffers(int fd) {
  int limit = 4096;
  REQUIRE(setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &limit, sizeof(limit)) == 0);
  REQUIRE(setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &limit, sizeof(limit)) == 0);
#ifdef __APPLE__
  // BSD writable readiness uses SO_SNDLOWAT; make it independent of the
  // kernel's default low-water mark versus our deliberately small buffers.
  int lowWater = 1;
  REQUIRE(setsockopt(fd, SOL_SOCKET, SO_SNDLOWAT, &lowWater, sizeof(lowWater)) == 0);
#endif
}
}  // namespace socket_test
