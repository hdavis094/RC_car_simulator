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
#include <thread>

#include "fake_sim.h"

namespace {
using namespace rcsim::hal;
struct Socket {
  int fd;
  explicit Socket(int family) : fd(::socket(family, SOCK_STREAM, 0)) { REQUIRE(fd >= 0); }
  ~Socket() { ::close(fd); }
  bool readable(int timeout = 0) const {
    pollfd p{fd, POLLIN, 0};
    return ::poll(&p, 1, timeout) == 1 && (p.revents & POLLIN);
  }
  void connect(uint16_t port) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    REQUIRE(::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
  }
  void write(const std::string& text) {
    size_t sent = 0;
    while (sent < text.size()) {
      const auto n = ::send(fd, text.data() + sent, text.size() - sent, 0);
      REQUIRE(n > 0);
      sent += static_cast<size_t>(n);
    }
  }
  void read(std::string& text) {
    while (readable()) {
      char buffer[16384];
      auto n = ::recv(fd, buffer, sizeof(buffer), 0);
      if (n <= 0) return;
      text.append(buffer, static_cast<size_t>(n));
    }
  }
};
struct Process {
  pid_t pid = -1;
  ~Process() {
    if (pid > 0) {
      kill(pid, SIGKILL);
      waitpid(pid, nullptr, 0);
    }
  }
  void launch(const std::filesystem::path& executable, const std::string& socket,
              const std::filesystem::path& errors) {
    pid = fork();
    REQUIRE(pid >= 0);
    if (pid != 0) return;
    setenv("RCSIM_SOCKET", socket.c_str(), 1);
    FILE* output = std::fopen(errors.c_str(), "w");
    if (!output || dup2(fileno(output), STDERR_FILENO) < 0) _exit(125);
    std::fclose(output);
    execl(executable.c_str(), executable.c_str(), static_cast<char*>(nullptr));
    _exit(126);
  }
  int wait() {
    for (int i = 0; i < 300; ++i) {
      int status = 0;
      if (waitpid(pid, &status, WNOHANG) == pid) {
        pid = -1;
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    throw std::runtime_error("firmware did not exit");
  }
};
std::vector<JsonDocument> messages(const std::string& text) {
  std::vector<JsonDocument> result;
  size_t start = 0, end;
  while ((end = text.find('\n', start)) != std::string::npos) {
    JsonDocument message;
    REQUIRE_FALSE(deserializeJson(message, text.substr(start, end - start)));
    result.push_back(std::move(message));
    start = end + 1;
  }
  return result;
}
}  // namespace

TEST_CASE(
    "built starter firmware serves control and telemetry through 3 s arming plus 2 s driving") {
  const std::filesystem::path root = std::getenv("STARTER_PROJECT");
  const std::string socketPath = "/tmp/rcsim-starter-" + std::to_string(getpid()) + ".sock";
  REQUIRE(validSocketPath(socketPath));
  unlink(socketPath.c_str());
  struct Cleanup {
    std::string path;
    ~Cleanup() { unlink(path.c_str()); }
  } cleanup{socketPath};
  Socket listener(AF_UNIX), first(AF_INET), second(AF_INET);
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::strcpy(address.sun_path, socketPath.c_str());
  REQUIRE(::bind(listener.fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
  REQUIRE(::listen(listener.fd, 1) == 0);
  Process firmware;
  firmware.launch(root / ".rcsim/build/firmware", socketPath, root / ".rcsim/firmware-errors");
  REQUIRE(listener.readable(2000));
  int fd = ::accept(listener.fd, nullptr, nullptr);
  REQUIRE(fd >= 0);
  struct Close {
    int fd;
    ~Close() { ::close(fd); }
  } close{fd};
  timeval timeout{2, 0};
  REQUIRE(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0);
  REQUIRE(receive(fd)["type"] == "HELLO");
  hal_test::FakeSim sim;
  send(fd, sim.config);
  uint16_t port = 0;
  std::string serial, firstText, secondText;
  bool connected = false, replaced = false, sawAuto = false, sawDrive = false, sawFailsafe = false;
  uint32_t escPulse = 0, steeringPulse = 0;
  for (uint64_t tick = 0; tick < 5100; ++tick) {
    if (tick == 100) first.write("{\"t\":\"drive\",\"seq\":100,\"throttle\":0.8,\"steer\":-0.5}\n");
    if (tick == 2900) first.write("{\"t\":\"mode\",\"mode\":\"auto\"}\n");
    if (tick == 3500) first.write("{\"t\":\"estop\"}\n");
    if (tick == 3510) first.write("{\"t\":\"drive\",\"seq\":101,\"throttle\":1,\"steer\":1}\n");
    if (tick == 3600) first.write("{\"t\":\"mode\",\"mode\":\"manual\"}\n");
    if (tick == 3650)
      first.write("{\"t\":\"drive\",\"seq\":101,\"throttle\":0.4,\"steer\":-0.2}\n");
    if (tick == 3900) first.write("{\"t\":\"drive\",\"seq\":101,\"throttle\":1,\"steer\":1}\n");
    if (tick == 4300) {
      second.connect(port);
      replaced = true;
      // Fragment the command across ticks and prove an old partial line cannot leak.
      first.write("{\"t\":\"drive\"");
      second.write("{\"t\":\"drive\",\"seq\":0,");
    }
    if (tick == 4310) second.write("\"throttle\":0.5,\"steer\":0.3}\r\n");
    if (tick == 4400)
      second.write(std::string(4096, 'x') + "\n{\"t\":\"unknown\"}\n{\"t\":\"estop\"}\n");
    if (tick == 4500) second.write("{\"t\":\"mode\",\"mode\":\"auto\"}\n");
    send(fd, sim.next());
    auto done = receive(fd);
    REQUIRE(done["type"] == "STEP_DONE");
    REQUIRE(done["message"]["tick"] == tick);
    auto data = done["message"].as<JsonVariantConst>();
    for (auto byte : data["serialTx"].as<JsonArrayConst>())
      serial += static_cast<char>(byte.as<uint8_t>());
    for (auto event : data["netEvents"].as<JsonArrayConst>()) {
      if (event["type"] == "listen" && event["proto"] == "tcp") {
        REQUIRE_FALSE(connected);
        CHECK(event["firmwarePort"] == 3333);
        port = event["hostPort"].as<uint16_t>();
        first.connect(port);
        connected = true;
      }
    }
    for (auto pwm : data["pwm"].as<JsonArrayConst>()) {
      if (pwm["gpio"] == 26) escPulse = pwm["pulseUs"].as<uint32_t>();
      if (pwm["gpio"] == 25) steeringPulse = pwm["pulseUs"].as<uint32_t>();
    }
    if (tick > 10 && tick < 3000) {
      CHECK(escPulse == 1500);
      CHECK(steeringPulse == 1500);
    }
    if (tick > 3050 && tick < 3450) {
      CHECK(escPulse > 1500);
      sawAuto = true;
    }
    if (tick > 3550 && tick < 3640) CHECK(escPulse == 1500);
    if (tick > 3700 && tick < 4100) {
      CHECK(escPulse == 1700);
      CHECK(steeringPulse == 1400);
      sawDrive = true;
    }
    if (tick > 4200 && tick < 4300) {
      CHECK(escPulse == 1500);
      CHECK(steeringPulse == 1500);
      sawFailsafe = true;
    }
    if (tick > 4350 && tick < 4400) CHECK(escPulse == 1750);
    if (tick > 4450 && tick < 4500) CHECK(escPulse == 1500);
    if (connected) first.read(firstText);
    if (replaced) second.read(secondText);
  }
  // STEP_DONE follows the socket pump, so the final transmitted bytes are readable.
  first.read(firstText);
  second.read(secondText);
  JsonDocument bye;
  bye["type"] = "BYE";
  bye["message"]["reason"] = "shutdown";
  bye["message"]["message"] = "starter test complete";
  send(fd, bye);
  CHECK(firmware.wait() == 0);
  INFO(serial);
  CHECK(connected);
  CHECK(replaced);
  CHECK(sawAuto);
  CHECK(sawDrive);
  CHECK(sawFailsafe);
  CHECK(serial.find("Donkey Car starter firmware") != std::string::npos);
  CHECK(serial.find("ESC armed after 3000 ms neutral") != std::string::npos);
  CHECK(serial.find("initialization failed") == std::string::npos);
  CHECK(serial.find("failsafe: no drive for 500 ms") != std::string::npos);
  CHECK(secondText.find("longer than 4096 bytes") != std::string::npos);
  CHECK(secondText.find("ignored invalid control command") != std::string::npos);
  const auto original = messages(firstText), replacement = messages(secondText);
  REQUIRE_FALSE(original.empty());
  REQUIRE_FALSE(replacement.empty());
  for (const auto* stream : {&original, &replacement}) {
    CHECK((*stream)[0]["t"] == "hello");
    CHECK((*stream)[0]["name"] == "Default car");
    CHECK((*stream)[0]["fw"] == "0.1.0");
    CHECK((*stream)[0]["proto"] == 1);
    uint32_t last = 0;
    size_t count = 0;
    for (const auto& message : *stream) {
      if (message["t"] != "telemetry") continue;
      const auto ms = message["ms"].as<uint32_t>();
      if (count) CHECK(ms - last == doctest::Approx(50).epsilon(0.06));
      last = ms;
      ++count;
      CHECK(message["tof_mm"][0] == 812);
      CHECK(message["tof_mm"][1] == 1200);
      CHECK(message["tof_mm"][2] == 640);
      CHECK(message["batt_mv"].as<unsigned>() > 8000);
      CHECK(message["yaw_dps"].as<float>() == doctest::Approx(57.3).epsilon(0.01));
      if (ms < 3000) CHECK(message["throttle"] == 0);
    }
    CHECK(count >= (stream == &original ? 80 : 14));
  }
}
