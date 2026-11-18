#include "outbound.h"

#if defined(ARDUINO_ARCH_ESP32)
#include <lwip/opt.h>
#include <lwip/sockets.h>
#else
#include <sys/select.h>
#include <sys/socket.h>
#endif

#include <cerrno>

namespace car {
#if defined(ARDUINO_ARCH_ESP32)
static_assert(kOutboundBytes <= TCP_SNDLOWAT,
              "Outbound lines must fit lwIP's writable low-water mark");
#endif
SendResult trySendSocket(int fd, const uint8_t* bytes, size_t size) {
#if defined(ARDUINO_ARCH_ESP32)
  // lwIP fd sets can be offset; FD_SETSIZE alone need not include that offset.
  constexpr int maxFd = LWIP_SELECT_MAXNFDS;
#else
  constexpr int maxFd = FD_SETSIZE;
#endif
  if (fd < 0 || fd >= maxFd || size > kOutboundBytes) return SendResult::Dropped;
  // Arduino-ESP32 3.2.1: Print::availableForWrite is the default 0 (no override):
  // https://github.com/espressif/arduino-esp32/blob/3.2.1/cores/esp32/Print.h#L74-L79
  // NetworkClient::write has fixed 1 s select waits / 10 retries; SO_SNDTIMEO
  // and setTimeout do not remove those waits. setOption targets IPPROTO_TCP;
  // fd() also permits SOL_SOCKET options, but cannot change that select loop:
  // https://github.com/espressif/arduino-esp32/blob/3.2.1/libraries/Network/src/NetworkClient.cpp#L324-L342
  // fd() is public; bypass write():
  // https://github.com/espressif/arduino-esp32/blob/3.2.1/libraries/Network/src/NetworkClient.cpp#L32-L35
  // https://github.com/espressif/arduino-esp32/blob/3.2.1/libraries/Network/src/NetworkClient.cpp#L388-L448
  // https://github.com/espressif/arduino-esp32/blob/3.2.1/libraries/Network/src/NetworkClient.cpp#L678-L684
  // ESP-IDF 5.4.2's pinned lwIP: writable is cleared at <= TCP_SNDLOWAT and
  // restored above it. With this socket's sole writer and lines <= that mark,
  // one nonblocking tcp_write can accept the entire line or fail with ERR_MEM.
  // tcp_write rolls back allocations on ERR_MEM, so no prefix is enqueued:
  // https://github.com/espressif/esp-lwip/blob/fa4dffdfac52587a26c1f29258376df750cf8474/src/core/tcp_out.c#L455-L469
  // No other task may write to this socket. A zero-time select is essential:
  // https://github.com/espressif/esp-lwip/blob/fa4dffdfac52587a26c1f29258376df750cf8474/src/api/api_msg.c#L386-L398
  // https://github.com/espressif/esp-lwip/blob/fa4dffdfac52587a26c1f29258376df750cf8474/src/api/api_msg.c#L1774-L1824
  // https://github.com/espressif/esp-lwip/blob/fa4dffdfac52587a26c1f29258376df750cf8474/src/api/sockets.c#L1918-L1922
  fd_set writable;
  FD_ZERO(&writable);
  FD_SET(fd, &writable);
  timeval immediate{};
  if (select(fd + 1, nullptr, &writable, nullptr, &immediate) != 1) return SendResult::Dropped;
  int flags = MSG_DONTWAIT;
#ifdef MSG_NOSIGNAL
  flags |= MSG_NOSIGNAL;
#endif
  const auto written = ::send(fd, bytes, size, flags);
  if (written >= 0 && static_cast<size_t>(written) == size) return SendResult::Sent;
  if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR))
    return SendResult::Dropped;
  // Defensive guard for other stacks: never append another message to a prefix.
  // The caller aborts this connection, so the peer discards its incomplete line.
  return SendResult::Disconnect;
}
}  // namespace car
