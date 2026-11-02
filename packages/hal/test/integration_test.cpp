#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <regex>
#include <thread>

#include "fake_sim.h"

using namespace rcsim::hal;
namespace {
namespace fs = std::filesystem;
struct Child {
  pid_t pid = -1;
  ~Child() {
    if (pid > 0) {
      kill(pid, SIGKILL);
      waitpid(pid, nullptr, 0);
    }
  }
  void launch(const std::string& program, const std::vector<std::string>& args,
              const fs::path& errors, const std::string& socket = "") {
    pid = fork();
    REQUIRE(pid >= 0);
    if (pid == 0) {
      if (!socket.empty()) setenv("RCSIM_SOCKET", socket.c_str(), 1);
      FILE* file = std::fopen(errors.c_str(), "w");
      if (!file || dup2(fileno(file), STDERR_FILENO) < 0) _exit(125);
      std::fclose(file);
      std::vector<char*> argv{const_cast<char*>(program.c_str())};
      for (const auto& a : args) argv.push_back(const_cast<char*>(a.c_str()));
      argv.push_back(nullptr);
      execv(program.c_str(), argv.data());
      _exit(126);
    }
  }
  int wait(int seconds = 20) {
    for (int i = 0; i < seconds * 100; ++i) {
      int status = 0;
      if (waitpid(pid, &status, WNOHANG) == pid) {
        pid = -1;
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("child process timeout");
  }
};
struct SocketFd {
  int fd = -1;
  SocketFd(int domain, int type) : fd(::socket(domain, type, 0)) { REQUIRE(fd >= 0); }
  ~SocketFd() {
    if (fd >= 0) ::close(fd);
  }
  bool readable(int ms = 2000) {
    pollfd p{fd, POLLIN, 0};
    return ::poll(&p, 1, ms) == 1 && (p.revents & POLLIN);
  }
};
std::string contents(const fs::path& file) {
  std::ifstream in(file);
  return {std::istreambuf_iterator<char>(in), {}};
}
struct Project {
  fs::path root = fs::absolute(fs::path("build") / ("integration-" + std::to_string(getpid())) /
                               "firmware project '$()'");
  Project() {
    fs::remove_all(root.parent_path());
    fs::create_directories(root / "src");
    fs::copy_file("test/fixtures/firmware/src/main.cpp", root / "src/main.cpp");
  }
  ~Project() { fs::remove_all(root.parent_path()); }
  void build() {
    Child build;
    build.launch(fs::absolute("bin/build-sim").string(), {root.string()}, root / "diagnostics");
    int status = build.wait(30);
    INFO(contents(root / "diagnostics"));
    REQUIRE(status == 0);
  }
};
}  // namespace
TEST_CASE("build driver preserves compiler file:line:column diagnostics and failure status") {
  Project p;
  std::ofstream(p.root / "src/main.cpp")
      << "#include <Arduino.h>\nvoid setup() { missing_symbol(); }\nvoid loop() {}\n";
  Child build;
  build.launch(fs::absolute("bin/build-sim").string(), {p.root.string()}, p.root / "diagnostics");
  CHECK(build.wait(30) != 0);
  auto text = contents(p.root / "diagnostics");
  INFO(text);
  CHECK(std::regex_search(text, std::regex(R"(main.cpp:[0-9]+:[0-9]+: error:)")));
}
TEST_CASE("C++ fake sim drives built firmware for 400 ticks and reaches its reported TCP port") {
  Project p;
  p.build();
  std::string path = "/tmp/rcsim-" + std::to_string(getpid()) + "-hal.sock";
  REQUIRE(validSocketPath(path));
  unlink(path.c_str());
  struct Unlink {
    std::string path;
    ~Unlink() { unlink(path.c_str()); }
  } cleanup{path};
  SocketFd listener(AF_UNIX, SOCK_STREAM);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::strcpy(addr.sun_path, path.c_str());
  REQUIRE(::bind(listener.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  REQUIRE(::listen(listener.fd, 1) == 0);
  Child firmware;
  firmware.launch((p.root / ".rcsim/build/firmware").string(), {}, p.root / "stderr", path);
  REQUIRE(listener.readable());
  int fd = ::accept(listener.fd, nullptr, nullptr);
  REQUIRE(fd >= 0);
  struct Close {
    int fd;
    ~Close() { ::close(fd); }
  } close{fd};
  timeval timeout{2, 0};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  auto hello = receive(fd);
  CHECK(hello["type"] == "HELLO");
  CHECK(hello["message"]["protocolVersion"] == 1);
  hal_test::FakeSim sim;
  // Split CONFIG at every byte to exercise stream reads independent of framing.
  auto config = encode(sim.config);
  for (auto byte : config) REQUIRE(::send(fd, &byte, 1, 0) == 1);
  SocketFd controller(AF_INET, SOCK_STREAM);
  bool connected = false, pwm = false, gpio = false;
  std::string serial, response;
  for (uint64_t tick = 0; tick < 400; ++tick) {
    auto step = sim.next();
    send(fd, step);
    auto done = receive(fd);
    REQUIRE(done["type"] == "STEP_DONE");
    REQUIRE(done["message"]["tick"] == tick);
    auto d = done["message"].as<JsonVariantConst>();
    for (auto b : d["serialTx"].as<JsonArrayConst>()) serial += static_cast<char>(b.as<uint8_t>());
    pwm |= d["pwm"].size() > 0;
    gpio |= d["gpioWrites"].size() > 0;
    for (auto e : d["netEvents"].as<JsonArrayConst>()) {
      if (e["type"] != "listen" || e["proto"] != "tcp") continue;
      CHECK(e["firmwarePort"] == 3333);
      sockaddr_in host{};
      host.sin_family = AF_INET;
      host.sin_port = htons(e["hostPort"].as<uint16_t>());
      inet_pton(AF_INET, "127.0.0.1", &host.sin_addr);
      REQUIRE(::connect(controller.fd, reinterpret_cast<sockaddr*>(&host), sizeof(host)) == 0);
      connected = true;
      const char* command = "{\"t\":\"ping\"}\n";
      REQUIRE(::send(controller.fd, command, std::strlen(command), 0) ==
              static_cast<ssize_t>(std::strlen(command)));
    }
    if (connected && controller.readable(0)) {
      char b[512];
      auto n = recv(controller.fd, b, sizeof(b), 0);
      if (n > 0) response.append(b, static_cast<size_t>(n));
    }
  }
  JsonDocument bye;
  bye["type"] = "BYE";
  bye["message"]["reason"] = "shutdown";
  bye["message"]["message"] = "test complete";
  send(fd, bye);
  CHECK(firmware.wait(3) == 0);
  INFO(serial);
  INFO(response);
  INFO(contents(p.root / "stderr"));
  CHECK(connected);
  CHECK(pwm);
  CHECK(gpio);
  CHECK(serial.find("ranges:812,1200,640;") != std::string::npos);
  CHECK(serial.find("INIT FAILED") == std::string::npos);
  size_t count = 0, pos = 0;
  while ((pos = serial.find("delay:100001;", pos)) != std::string::npos) {
    ++count;
    ++pos;
  }
  CHECK(count == 3);
  CHECK(response.find("\"echo\":\"ping\"") != std::string::npos);
  CHECK(response.find("\"mm\":812") != std::string::npos);
  CHECK(contents(p.root / "stderr").find("test complete") != std::string::npos);
}
TEST_CASE("firmware reports socket loss and exits nonzero") {
  Project p;
  p.build();
  std::string path = "/tmp/rcsim-" + std::to_string(getpid()) + "-lost.sock";
  unlink(path.c_str());
  SocketFd listener(AF_UNIX, SOCK_STREAM);
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::strcpy(addr.sun_path, path.c_str());
  REQUIRE(::bind(listener.fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0);
  REQUIRE(::listen(listener.fd, 1) == 0);
  Child firmware;
  firmware.launch((p.root / ".rcsim/build/firmware").string(), {}, p.root / "stderr", path);
  REQUIRE(listener.readable());
  int fd = ::accept(listener.fd, nullptr, nullptr);
  REQUIRE(fd >= 0);
  receive(fd);
  ::close(fd);
  unlink(path.c_str());
  CHECK(firmware.wait(3) == 1);
  CHECK(contents(p.root / "stderr").find("sim socket lost") != std::string::npos);
}
