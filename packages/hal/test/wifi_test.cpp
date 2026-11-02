#include "WiFi.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>

#include "WiFiUdp.h"
#include "fake_sim.h"
#include "rcsim/network.h"

using namespace rcsim::hal;
using hal_test::FakeSim;
namespace {
template <typename T, typename = void>
struct HasFd : std::false_type {};
template <typename T>
struct HasFd<T, std::void_t<decltype(std::declval<T>().fd())>> : std::true_type {};
template <typename T, typename = void>
struct HasHostPort : std::false_type {};
template <typename T>
struct HasHostPort<T, std::void_t<decltype(std::declval<T>().hostPort())>> : std::true_type {};
static_assert(HasFd<WiFiClient>::value);
static_assert(!HasFd<WiFiServer>::value && !HasFd<WiFiUDP>::value);
static_assert(!HasHostPort<WiFiServer>::value);
using SteadyClock = std::chrono::steady_clock;
// Wall time belongs only in this host-side barrier. Never spend sim time waiting
// for the OS to deliver a packet, or start a latency assertion at peer send().
bool waitSocket(int fd, short events, SteadyClock::time_point deadline) {
  if (fd < 0) return false;
  while (true) {
    auto remaining = deadline - SteadyClock::now();
    int ms = remaining > SteadyClock::duration::zero()
                 ? static_cast<int>(
                       std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count()) +
                       1
                 : 0;
    pollfd p{fd, events, 0};
    int result = ::poll(&p, 1, ms);
    if (result < 0 && errno == EINTR && SteadyClock::now() < deadline) continue;
    return result > 0 && (p.revents & events);
  }
}
bool waitSocket(int fd, short events = POLLIN, int ms = 1000) {
  return waitSocket(fd, events, SteadyClock::now() + std::chrono::milliseconds(ms));
}
bool waitClientBytes(WiFiClient& client, int count) {
  auto deadline = SteadyClock::now() + std::chrono::seconds(1);
  while (client.available() < count) {
    if (SteadyClock::now() >= deadline || !waitSocket(client.fd(), POLLIN, deadline)) return false;
  }
  return true;
}
void checkSocketFlags(int fd) {
  REQUIRE(fd >= 0);
  int status = fcntl(fd, F_GETFL, 0);
  REQUIRE(status >= 0);
  CHECK((status & O_NONBLOCK) != 0);
  int descriptor = fcntl(fd, F_GETFD, 0);
  REQUIRE(descriptor >= 0);
  CHECK((descriptor & FD_CLOEXEC) != 0);
#ifdef SO_NOSIGPIPE
  int value = 0;
  socklen_t size = sizeof(value);
  REQUIRE(getsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &value, &size) == 0);
  CHECK(value == 1);
#endif
}
struct Host {
  int fd;
  explicit Host(bool udp = false) : fd(::socket(AF_INET, udp ? SOCK_DGRAM : SOCK_STREAM, 0)) {
    REQUIRE(fd >= 0);
  }
  ~Host() { ::close(fd); }
  bool readable(int ms = 1000) { return waitSocket(fd, POLLIN, ms); }
};
sockaddr_in hostAddress(uint16_t port) {
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  return a;
}
uint16_t reportedPort(const FakeSim& sim, const char* proto) {
  for (const auto& d : sim.done)
    for (auto e : d["message"]["netEvents"].as<JsonArrayConst>())
      if (e["type"] == "listen" && e["proto"] == proto) return e["hostPort"].as<uint16_t>();
  return 0;
}
}  // namespace
TEST_CASE(
    "WiFiServer accepts a real client on the reported port and supports shared client handles") {
  FakeSim sim;
  sim.start();
  CHECK(WiFi.begin("sim", "password") == WL_CONNECTED);
  CHECK(WiFi.status() == WL_CONNECTED);
  CHECK(WiFi.localIP().toString() == "127.0.0.1");
  WiFiServer server(3333);
  server.begin();
  delay(1);
  auto port = reportedPort(sim, "tcp");
  REQUIRE(port != 0);
  CHECK(port == hostPort(server));
  Host host;
  auto addr = hostAddress(port);
  REQUIRE(::connect(host.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  REQUIRE(waitSocket(socketFd(server)));
  auto client = server.available();
  REQUIRE(static_cast<bool>(client));
  auto copy = client;
  CHECK(copy.connected());
  checkSocketFlags(socketFd(server));
  checkSocketFlags(client.fd());
  CHECK(client.available() == 0);
  CHECK(client.read() == -1);
  REQUIRE(::send(host.fd, "hello", 5, 0) == 5);
  REQUIRE(waitClientBytes(client, 5));
  CHECK(client.available() == 5);
  CHECK(copy.peek() == 'h');
  CHECK(client.read() == 'h');
  CHECK(copy.read() == 'e');
  char reply[] = "reply";
  REQUIRE(client.write(reply, 5) == 5);
  REQUIRE(host.readable());
  char b[16];
  CHECK(::recv(host.fd, b, sizeof(b), 0) == 5);
  CHECK(std::string(b, 5) == "reply");
  client.stop();
  CHECK_FALSE(copy.connected());
  server.end();
  delay(1);
  bool connect = false, disconnect = false, unlisten = false;
  auto events = sim.done.back()["message"]["netEvents"].as<JsonArrayConst>();
  for (auto e : events) {
    connect |= e["type"] == "connect";
    disconnect |= e["type"] == "disconnect";
    unlisten |= e["type"] == "unlisten";
  }
  CHECK(connect);
  CHECK(disconnect);
  CHECK(unlisten);
}
TEST_CASE("WiFiClient opens a nonblocking outbound TCP connection") {
  FakeSim sim;
  sim.start();
  Host server;
  auto addr = hostAddress(0);
  REQUIRE(::bind(server.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  REQUIRE(::listen(server.fd, 1) == 0);
  socklen_t size = sizeof(addr);
  REQUIRE(getsockname(server.fd, reinterpret_cast<sockaddr*>(&addr), &size) == 0);
  WiFiClient client;
  REQUIRE(client.connect(IPAddress(127, 0, 0, 1), ntohs(addr.sin_port)) == 1);
  REQUIRE(server.readable());
  int peer = ::accept(server.fd, nullptr, nullptr);
  REQUIRE(peer >= 0);
  REQUIRE(waitSocket(client.fd(), POLLOUT));
  CHECK(client.connected());
  checkSocketFlags(client.fd());
  CHECK(client.print("outbound") == 8);
  REQUIRE(waitSocket(peer));
  char b[16];
  CHECK(::recv(peer, b, sizeof(b), 0) == 8);
  ::close(peer);
  client.stop();
}
TEST_CASE("UDP preserves packets and applies latency, total loss and dropout from STEP") {
  FakeSim sim;
  uint32_t latency = 2000, loss = 0;
  bool dropout = false;
  sim.prepare = [&](JsonDocument& d) {
    auto f = d["message"]["netFaults"].to<JsonObject>();
    f["latencyUs"] = latency;
    f["lossPpm"] = loss;
    f["dropout"] = dropout;
  };
  sim.start();
  WiFiUDP udp;
  REQUIRE(udp.begin(4210));
  checkSocketFlags(socketFd(udp));
  CHECK(udp.parsePacket() == 0);
  delay(1);
  auto port = reportedPort(sim, "udp");
  REQUIRE(port != 0);
  Host host(true);
  auto addr = hostAddress(port);
  REQUIRE(sendto(host.fd, "packet", 6, 0, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 6);
  REQUIRE(waitSocket(socketFd(udp)));
  CHECK(udp.parsePacket() == 0);
  delay(1);
  CHECK(udp.parsePacket() == 0);
  delay(1);
  REQUIRE(udp.parsePacket() == 6);
  CHECK(udp.peek() == 'p');
  CHECK(udp.read() == 'p');
  CHECK(udp.available() == 5);
  auto remoteIP = udp.remoteIP();
  auto remotePort = udp.remotePort();
  REQUIRE(remotePort != 0);
  CHECK(udp.beginPacket(remoteIP, remotePort));
  CHECK(udp.print("reply") == 5);
  CHECK(udp.endPacket());
  CHECK_FALSE(host.readable(0));
  delay(1);
  CHECK_FALSE(host.readable(0));
  delay(1);
  REQUIRE(host.readable());
  char b[16];
  CHECK(::recv(host.fd, b, sizeof(b), 0) == 5);
  loss = 1000000;
  latency = 0;
  delay(1);
  REQUIRE(sendto(host.fd, "lost", 4, 0, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 4);
  REQUIRE(waitSocket(socketFd(udp)));
  delay(1);
  CHECK(udp.parsePacket() == 0);
  CHECK(udp.beginPacket(remoteIP, remotePort));
  udp.print("lost");
  CHECK(udp.endPacket());
  CHECK_FALSE(host.readable(0));
  loss = 0;
  dropout = true;
  delay(1);
  REQUIRE(sendto(host.fd, "blocked", 7, 0, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 7);
  REQUIRE(waitSocket(socketFd(udp)));
  delay(1);
  CHECK(udp.parsePacket() == 0);
  dropout = false;
  delay(1);
  REQUIRE(sendto(host.fd, "back", 4, 0, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 4);
  REQUIRE(waitSocket(socketFd(udp)));
  CHECK(udp.parsePacket() == 4);
  udp.stop();
}

TEST_CASE("releasing the final socket handle reports disconnect and unlisten events") {
  FakeSim sim;
  sim.start();
  {
    WiFiServer server(3333);
    server.begin();
    delay(1);
    Host host;
    auto addr = hostAddress(reportedPort(sim, "tcp"));
    REQUIRE(::connect(host.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
    REQUIRE(waitSocket(socketFd(server)));
    auto client = server.available();
    REQUIRE(static_cast<bool>(client));
    auto copy = client;
    client = WiFiClient();
    CHECK(copy.connected());
    copy = WiFiClient();
  }
  delay(1);
  auto events = sim.done.back()["message"]["netEvents"].as<JsonArrayConst>();
  REQUIRE(events.size() == 3);
  CHECK(events[0]["type"] == "connect");
  CHECK(events[1]["type"] == "disconnect");
  CHECK(events[2]["type"] == "unlisten");
}

TEST_CASE("refused outbound connects return failure without spending sim time waiting") {
  FakeSim sim;
  sim.start();
  Host portHolder;
  auto addr = hostAddress(0);
  REQUIRE(::bind(portHolder.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  socklen_t size = sizeof(addr);
  REQUIRE(getsockname(portHolder.fd, reinterpret_cast<sockaddr*>(&addr), &size) == 0);
  WiFiClient client;
  auto before = runtime().nowNs();
  CHECK(client.connect("127.0.0.1", ntohs(addr.sin_port)) == 0);
  CHECK(runtime().nowNs() - before == 1000);
  CHECK(client.fd() == -1);
  CHECK_FALSE(client.connected());
  delay(1);
  CHECK(sim.done.back()["message"]["netEvents"].size() == 0);
}
TEST_CASE("closing outgoing TCP clients emits no unmatched server connection events") {
  FakeSim sim;
  sim.start();
  Host server;
  auto addr = hostAddress(0);
  REQUIRE(::bind(server.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  REQUIRE(::listen(server.fd, 1) == 0);
  socklen_t size = sizeof(addr);
  REQUIRE(getsockname(server.fd, reinterpret_cast<sockaddr*>(&addr), &size) == 0);
  {
    WiFiClient client;
    REQUIRE(client.connect("127.0.0.1", ntohs(addr.sin_port)) == 1);
    REQUIRE(server.readable());
    int peer = ::accept(server.fd, nullptr, nullptr);
    REQUIRE(peer >= 0);
    REQUIRE(client.connected());
    client.stop();
    ::close(peer);
  }
  {
    WiFiClient client;
    REQUIRE(client.connect("127.0.0.1", ntohs(addr.sin_port)) == 1);
    REQUIRE(server.readable());
    int peer = ::accept(server.fd, nullptr, nullptr);
    REQUIRE(peer >= 0);
    ::close(peer);
  }
  delay(1);
  CHECK(sim.done.back()["message"]["netEvents"].size() == 0);
}
