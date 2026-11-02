#include "WiFi.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <deque>
#include <vector>

#include "WiFiUdp.h"
#include "rcsim/network.h"
#include "rcsim/runtime.h"

namespace rcsim::hal {
struct Packet {
  Bytes bytes;
  uint64_t ready;
  sockaddr_in peer{};
  size_t offset = 0;
};
struct Socket {
  int fd = -1;
  bool udp = false, listener = false, mapped = false, serverClient = false, connected = false,
       reported = false;
  uint16_t firmwarePort = 0, hostPort = 0;
  sockaddr_in peer{};
  std::deque<Packet> rx, tx;
  Bytes current;
  size_t offset = 0;
  ~Socket();
};
namespace {
std::vector<std::weak_ptr<Socket>> sockets;
uint32_t randomState = 1;
bool seeded = false;
constexpr size_t kQueueBytes = 1048576;
std::string peerName(const sockaddr_in& peer) {
  char b[INET_ADDRSTRLEN]{};
  inet_ntop(AF_INET, &peer.sin_addr, b, sizeof(b));
  return std::string(b) + ":" + std::to_string(ntohs(peer.sin_port));
}
void event(Socket& s, const char* type) {
  if (!runtime().active()) return;
  auto e = runtime().netEvent();
  e["type"] = type;
  e["firmwarePort"] = s.firmwarePort;
  if (std::strcmp(type, "listen") == 0 || std::strcmp(type, "unlisten") == 0) {
    e["proto"] = s.udp ? "udp" : "tcp";
    if (std::strcmp(type, "listen") == 0) {
      e["hostPort"] = s.hostPort;
      e["bindAddress"] = runtime().config()["net"]["bindAddress"];
    }
  } else
    e["peer"] = peerName(s.peer);
}
void closeSocket(Socket& s) {
  if (s.fd < 0) return;
  ::close(s.fd);
  s.fd = -1;
  if (s.mapped)
    event(s, "unlisten");
  else if (s.serverClient && s.connected && !s.reported) {
    event(s, "disconnect");
    s.reported = true;
  }
  s.connected = false;
}
bool blocked() { return runtime().faults()["dropout"].as<bool>(); }
bool lost() {
  randomState ^= randomState << 13;
  randomState ^= randomState >> 17;
  randomState ^= randomState << 5;
  return randomState % 1000000 < runtime().faults()["lossPpm"].as<uint32_t>();
}
uint64_t readyTime() {
  return runtime().nowNs() + runtime().faults()["latencyUs"].as<uint64_t>() * 1000;
}
size_t queued(const std::deque<Packet>& queue) {
  size_t n = 0;
  for (const auto& p : queue) n += p.bytes.size() - p.offset;
  return n;
}
void pump() {
  auto now = runtime().nowNs();
  for (auto it = sockets.begin(); it != sockets.end();) {
    auto s = it->lock();
    if (!s) {
      it = sockets.erase(it);
      continue;
    }
    ++it;
    if (s->fd < 0 || s->listener) continue;
    // Bound work per HAL boundary so a host flooding the port cannot stall sim time.
    for (int i = 0; i < 16 && s->fd >= 0 && queued(s->rx) < kQueueBytes; ++i) {
      uint8_t b[65536];
      sockaddr_in peer{};
      socklen_t size = sizeof(peer);
      ssize_t n = s->udp
                      ? recvfrom(s->fd, b, sizeof(b), 0, reinterpret_cast<sockaddr*>(&peer), &size)
                      : recv(s->fd, b, 4096, 0);
      if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) closeSocket(*s);
        break;
      }
      if (n == 0 && !s->udp) {
        closeSocket(*s);
        break;
      }
      if (!blocked() && !lost()) s->rx.push_back({Bytes(b, b + n), readyTime(), peer, 0});
    }
    while (s->fd >= 0 && !blocked() && !s->tx.empty() && s->tx.front().ready <= now) {
      auto& p = s->tx.front();
      ssize_t n = s->udp ? sendto(s->fd, p.bytes.data(), p.bytes.size(), 0,
                                  reinterpret_cast<sockaddr*>(&p.peer), sizeof(p.peer))
                         : ::send(s->fd, p.bytes.data() + p.offset, p.bytes.size() - p.offset, 0);
      if (n < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) closeSocket(*s);
        break;
      }
      if (!n && !s->udp) break;
      p.offset += static_cast<size_t>(n);
      if (p.offset == p.bytes.size() || s->udp) s->tx.pop_front();
    }
  }
}
void install() {
  if (!seeded) {
    randomState = runtime().config()["seed"].as<uint32_t>();
    if (!randomState) randomState = 1;
    seeded = true;
  }
  runtime().poll = pump;
}
bool destination(const char* host, uint16_t port, sockaddr_in& addr) {
  addr = {};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  return inet_pton(AF_INET, std::strcmp(host, "localhost") == 0 ? "127.0.0.1" : host,
                   &addr.sin_addr) == 1;
}
std::shared_ptr<Socket> create(bool udp) {
  install();
  auto s = std::make_shared<Socket>();
  s->udp = udp;
  s->fd = ::socket(AF_INET, udp ? SOCK_DGRAM : SOCK_STREAM, 0);
  if (s->fd < 0) return {};
  if (fcntl(s->fd, F_SETFL, fcntl(s->fd, F_GETFL, 0) | O_NONBLOCK) < 0) return {};
  fcntl(s->fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
  int yes = 1;
  setsockopt(s->fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
#endif
  sockets.push_back(s);
  return s;
}
std::shared_ptr<Socket> listenSocket(uint16_t port, bool udp, int backlog = 4) {
  auto s = create(udp);
  if (!s) return {};
  sockaddr_in addr{};
  if (!destination(runtime().config()["net"]["bindAddress"].as<const char*>(), 0, addr) ||
      ::bind(s->fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0 ||
      (!udp && ::listen(s->fd, backlog) < 0))
    return {};
  socklen_t size = sizeof(addr);
  if (getsockname(s->fd, reinterpret_cast<sockaddr*>(&addr), &size) < 0) return {};
  s->hostPort = ntohs(addr.sin_port);
  s->firmwarePort = port;
  s->listener = !udp;
  s->mapped = true;
  s->connected = udp;
  event(*s, "listen");
  return s;
}
int available(Socket* s) {
  if (!s || blocked()) return 0;
  size_t n = 0;
  for (const auto& p : s->rx) {
    if (p.ready > runtime().nowNs()) break;
    n += p.bytes.size() - p.offset;
  }
  return static_cast<int>(n);
}
int read(Socket* s, bool consume) {
  if (!available(s)) return -1;
  auto& p = s->rx.front();
  int b = p.bytes[p.offset];
  if (consume && ++p.offset == p.bytes.size()) s->rx.pop_front();
  return b;
}
size_t enqueue(Socket* s, const uint8_t* data, size_t size, const sockaddr_in& peer = {}) {
  if (!s || s->fd < 0 || (!size && !s->udp)) return 0;
  if (blocked() || lost()) return size;
  auto n = std::min(size, kQueueBytes - std::min(kQueueBytes, queued(s->tx)));
  if (s->udp && n < size) return 0;
  if (n == 0 && size != 0) return 0;
  Bytes bytes;
  if (n) bytes.assign(data, data + n);
  s->tx.push_back({std::move(bytes), readyTime(), peer, 0});
  pump();
  return n;
}
IPAddress ip(const sockaddr_in& addr) { return IPAddress(addr.sin_addr.s_addr); }
}  // namespace
Socket::~Socket() {
  if (fd < 0) return;
  ::close(fd);
  // Destruction cannot throw, including when the diagnostics buffer is full.
  try {
    if (mapped)
      event(*this, "unlisten");
    else if (serverClient && connected && !reported)
      event(*this, "disconnect");
  } catch (...) {
  }
}
}  // namespace rcsim::hal
using namespace rcsim::hal;
WiFiClass WiFi;
IPAddress::IPAddress(uint32_t address) { std::memcpy(bytes_, &address, 4); }
bool IPAddress::fromString(const char* address) {
  in_addr addr{};
  if (inet_pton(AF_INET, address, &addr) != 1) return false;
  std::memcpy(bytes_, &addr.s_addr, 4);
  return true;
}
String IPAddress::toString() const {
  char b[16];
  std::snprintf(b, sizeof(b), "%u.%u.%u.%u", bytes_[0], bytes_[1], bytes_[2], bytes_[3]);
  return b;
}
IPAddress::operator uint32_t() const {
  uint32_t n;
  std::memcpy(&n, bytes_, 4);
  return n;
}
int WiFiClass::begin(const char*, const char*) {
  install();
  runtime().call();
  connected_ = true;
  return WL_CONNECTED;
}
int WiFiClass::status() {
  runtime().call();
  return connected_ ? WL_CONNECTED : WL_DISCONNECTED;
}
IPAddress WiFiClass::localIP() {
  runtime().call();
  IPAddress ip;
  ip.fromString(runtime().config()["net"]["bindAddress"].as<const char*>());
  return ip;
}
bool WiFiClass::mode(int) {
  runtime().call();
  return true;
}
bool WiFiClass::disconnect(bool, bool) {
  runtime().call();
  connected_ = false;
  return true;
}
WiFiClient::WiFiClient(std::shared_ptr<Socket> socket) : socket_(std::move(socket)) {}
int WiFiClient::connect(const char* host, uint16_t port) {
  runtime().call();
  if (socket_) closeSocket(*socket_);
  socket_ = create(false);
  if (!socket_) return 0;
  if (!destination(host, port, socket_->peer)) {
    closeSocket(*socket_);
    return 0;
  }
  int result =
      ::connect(socket_->fd, reinterpret_cast<sockaddr*>(&socket_->peer), sizeof(socket_->peer));
  if (result < 0 && errno == EINPROGRESS) {
    // Resolve the Arduino connect result in host time; never advance the sim clock.
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    while (true) {
      auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                           deadline - std::chrono::steady_clock::now())
                           .count();
      if (remaining < 0) break;
      pollfd p{socket_->fd, POLLOUT, 0};
      int ready = ::poll(&p, 1, static_cast<int>(remaining) + 1);
      if (ready < 0 && errno == EINTR) continue;
      int error = 0;
      socklen_t size = sizeof(error);
      if (ready > 0 && (p.revents & (POLLOUT | POLLERR | POLLHUP)) &&
          getsockopt(socket_->fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0)
        result = 0;
      break;
    }
  }
  if (result < 0) {
    closeSocket(*socket_);
    return 0;
  }
  socket_->connected = true;
  return 1;
}
int WiFiClient::connect(IPAddress host, uint16_t port) {
  return connect(host.toString().c_str(), port);
}
uint8_t WiFiClient::connected() {
  runtime().call();
  return socket_ && (socket_->connected || rcsim::hal::available(socket_.get()));
}
WiFiClient::operator bool() const {
  runtime().call();
  return socket_ && (socket_->fd >= 0 || rcsim::hal::available(socket_.get()) > 0);
}
size_t WiFiClient::write(const uint8_t* data, size_t size) {
  runtime().call();
  return enqueue(socket_.get(), data, size);
}
int WiFiClient::available() {
  runtime().call();
  return rcsim::hal::available(socket_.get());
}
int WiFiClient::read() {
  runtime().call();
  return rcsim::hal::read(socket_.get(), true);
}
int WiFiClient::peek() {
  runtime().call();
  return rcsim::hal::read(socket_.get(), false);
}
void WiFiClient::flush() {
  runtime().call();
  pump();
}
void WiFiClient::stop() {
  runtime().call();
  if (socket_) {
    closeSocket(*socket_);
    socket_->rx.clear();
    socket_->tx.clear();
  }
  socket_.reset();
}
IPAddress WiFiClient::remoteIP() const {
  runtime().call();
  return socket_ ? ip(socket_->peer) : IPAddress();
}
uint16_t WiFiClient::remotePort() const {
  runtime().call();
  return socket_ ? ntohs(socket_->peer.sin_port) : 0;
}
int WiFiClient::setNoDelay(bool enabled) {
  runtime().call();
  int value = enabled;
  return socket_ && setsockopt(socket_->fd, IPPROTO_TCP, TCP_NODELAY, &value, sizeof(value)) == 0;
}
WiFiServer::WiFiServer(uint16_t port, uint8_t maxClients) : port_(port), maxClients_(maxClients) {}
void WiFiServer::begin(uint16_t port) {
  runtime().call();
  if (port) port_ = port;
  if (socket_) closeSocket(*socket_);
  socket_ = listenSocket(port_, false, maxClients_);
}
WiFiClient WiFiServer::available() { return accept(); }
WiFiClient WiFiServer::accept() {
  runtime().call();
  if (!socket_ || blocked()) return {};
  auto s = std::make_shared<Socket>();
  socklen_t size = sizeof(s->peer);
  s->fd = ::accept(socket_->fd, reinterpret_cast<sockaddr*>(&s->peer), &size);
  if (s->fd < 0) return {};
  if (fcntl(s->fd, F_SETFL, fcntl(s->fd, F_GETFL, 0) | O_NONBLOCK) < 0) return {};
  fcntl(s->fd, F_SETFD, FD_CLOEXEC);
#ifdef SO_NOSIGPIPE
  int yes = 1;
  setsockopt(s->fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
#endif
  int noDelay = noDelay_;
  setsockopt(s->fd, IPPROTO_TCP, TCP_NODELAY, &noDelay, sizeof(noDelay));
  s->connected = true;
  s->serverClient = true;
  s->firmwarePort = port_;
  sockets.push_back(s);
  event(*s, "connect");
  return WiFiClient(s);
}
void WiFiServer::end() {
  runtime().call();
  if (socket_) closeSocket(*socket_);
  socket_.reset();
}
void WiFiServer::stop() { end(); }
void WiFiServer::setNoDelay(bool enabled) {
  runtime().call();
  noDelay_ = enabled;
}

uint8_t WiFiUDP::begin(uint16_t port) {
  runtime().call();
  if (socket_) stop();
  socket_ = listenSocket(port, true);
  return socket_ ? 1 : 0;
}
void WiFiUDP::stop() {
  runtime().call();
  if (socket_) {
    socket_->connected = false;
    closeSocket(*socket_);
  }
  socket_.reset();
}
int WiFiUDP::beginPacket(const char* host, uint16_t port) {
  runtime().call();
  if (!socket_) socket_ = create(true);
  host_ = host;
  port_ = port;
  packet_.clear();
  sockaddr_in addr{};
  return socket_ && destination(host, port, addr);
}
int WiFiUDP::beginPacket(IPAddress host, uint16_t port) {
  return beginPacket(host.toString().c_str(), port);
}
size_t WiFiUDP::write(const uint8_t* data, size_t size) {
  runtime().call();
  size_t n = std::min(size, size_t(65507) - packet_.size());
  packet_.insert(packet_.end(), data, data + n);
  return n;
}
int WiFiUDP::endPacket() {
  runtime().call();
  sockaddr_in addr{};
  if (!destination(host_.c_str(), port_, addr)) return 0;
  return enqueue(socket_.get(), packet_.data(), packet_.size(), addr) == packet_.size();
}
int WiFiUDP::parsePacket() {
  runtime().call();
  if (!socket_ || blocked()) return 0;
  socket_->current.clear();
  socket_->offset = 0;
  if (socket_->rx.empty() || socket_->rx.front().ready > runtime().nowNs()) return 0;
  auto p = std::move(socket_->rx.front());
  socket_->rx.pop_front();
  socket_->current = std::move(p.bytes);
  socket_->peer = p.peer;
  return static_cast<int>(socket_->current.size());
}
int WiFiUDP::available() {
  runtime().call();
  return !socket_ || blocked() ? 0 : static_cast<int>(socket_->current.size() - socket_->offset);
}
int WiFiUDP::read() {
  runtime().call();
  return !socket_ || blocked() || socket_->offset == socket_->current.size()
             ? -1
             : socket_->current[socket_->offset++];
}
int WiFiUDP::peek() {
  runtime().call();
  return !socket_ || blocked() || socket_->offset == socket_->current.size()
             ? -1
             : socket_->current[socket_->offset];
}
void WiFiUDP::flush() {
  runtime().call();
  if (socket_) {
    socket_->current.clear();
    socket_->offset = 0;
  }
}
IPAddress WiFiUDP::remoteIP() const {
  runtime().call();
  return socket_ ? ip(socket_->peer) : IPAddress();
}
uint16_t WiFiUDP::remotePort() const {
  runtime().call();
  return socket_ ? ntohs(socket_->peer.sin_port) : 0;
}

int WiFiClient::fd() const { return socket_ ? socket_->fd : -1; }
namespace rcsim::hal {
struct NetworkAccess {
  static const std::shared_ptr<Socket>& socket(const WiFiServer& server) { return server.socket_; }
  static const std::shared_ptr<Socket>& socket(const WiFiUDP& udp) { return udp.socket_; }
};
int socketFd(const WiFiServer& server) {
  auto& s = NetworkAccess::socket(server);
  return s ? s->fd : -1;
}
int socketFd(const WiFiUDP& udp) {
  auto& s = NetworkAccess::socket(udp);
  return s ? s->fd : -1;
}
uint16_t hostPort(const WiFiServer& server) {
  auto& s = NetworkAccess::socket(server);
  return s ? s->hostPort : 0;
}
}  // namespace rcsim::hal
