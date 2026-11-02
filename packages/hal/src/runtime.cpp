#include "rcsim/runtime.h"

#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "rcsim/hal_version.h"

namespace rcsim::hal {
namespace {
int exitSocket = -1;
void firmwareExit() {
  int fd = exitSocket;
  exitSocket = -1;
  if (fd < 0) return;
  try {
    JsonDocument bye;
    bye["type"] = "BYE";
    bye["message"]["reason"] = "firmware-exit";
    bye["message"]["message"] = "firmware called exit()";
    send(fd, bye);
  } catch (...) {
  }
  ::close(fd);
}
}  // namespace
Runtime& runtime() {
  // Firmware may own global Wi-Fi objects. Keep the runtime alive while their
  // destructors report socket events, independent of static destruction order.
  static Runtime* instance = new Runtime;
  return *instance;
}
void Runtime::start(const JsonDocument& config, const JsonDocument& first, Exchange exchange) {
  active_ = false;
  config_ = config;
  auto c = this->config();
  if (config["type"] != "CONFIG" || c["protocolVersion"] != 1 || c["tickUs"] == 0)
    throw ProtocolError("invalid CONFIG");
  exchange_ = std::move(exchange);
  randomState_ = c["seed"].as<uint32_t>();
  if (!randomState_) randomState_ = 1;
  adcBits = 12;
  modes_.fill(0);
  levels_.fill(false);
  written_.fill(false);
  periods_.fill(0);
  pulses_.fill(0);
  rx_.clear();
  readings_.clear();
  faults_.clear();
  addresses_.clear();
  readings_.to<JsonArray>();
  for (auto d : c["devices"].as<JsonArrayConst>()) {
    addresses_.push_back(d["kind"] == "mpu6050" ? d["targetI2cAddress"].as<uint8_t>()
                                                : d["defaultI2cAddress"].as<uint8_t>());
    readings_.as<JsonArray>().add(nullptr);
  }
  step(first, true);
  active_ = true;
}
void Runtime::step(const JsonDocument& message, bool first) {
  if (message["type"] == "BYE") throw EndRun(message["message"]["message"].as<std::string>());
  if (message["type"] != "STEP") throw ProtocolError("expected STEP");
  auto s = message["message"];
  auto t0 = s["t0Us"].as<uint64_t>() * 1000;
  auto t1 = s["t1Us"].as<uint64_t>() * 1000;
  auto tick = s["tick"].as<uint64_t>();
  if (t1 <= t0 || t1 - t0 != config()["tickUs"].as<uint64_t>() * 1000 ||
      (!first && (t0 != end_ || tick != tick_ + 1)))
    throw ProtocolError("nonconsecutive STEP");
  if (first) boot_ = t0;
  tick_ = tick;
  now_ = t0;
  end_ = t1;
  edge_ = 0;
  uint64_t last = t0;
  for (auto e : s["gpioEdges"].as<JsonArrayConst>()) {
    auto at = e["tUs"].as<uint64_t>() * 1000;
    if (at < last || at >= end_) throw ProtocolError("GPIO edge outside STEP or unordered");
    last = at;
  }
  for (auto r : s["readings"].as<JsonArrayConst>()) {
    size_t d = r["device"];
    if (d >= deviceCount() || r["tUs"].as<uint64_t>() > s["t0Us"].as<uint64_t>())
      throw ProtocolError("invalid reading");
    readings_[d].set(r);
  }
  for (auto b : s["serialRx"].as<JsonArrayConst>()) {
    if (rx_.size() < 16384) rx_.push_back(b.as<uint8_t>());
  }
  if (!s["netFaults"].isNull()) faults_.set(s["netFaults"]);
  step_ = message;
  serialCount_ = 0;
  done_.clear();
  done_["type"] = "STEP_DONE";
  auto d = done_["message"].to<JsonObject>();
  d["tick"] = tick_;
  for (auto name : {"pwm", "gpioWrites", "serialTx", "netEvents", "logs"}) d[name].to<JsonArray>();
  edges();
}
void Runtime::edges() {
  auto list = step_["message"]["gpioEdges"].as<JsonArrayConst>();
  while (edge_ < list.size() && list[edge_]["tUs"].as<uint64_t>() * 1000 <= now_) {
    levels_[list[edge_]["gpio"].as<uint8_t>()] = list[edge_]["level"].as<bool>();
    ++edge_;
  }
}
void Runtime::advance(uint64_t ns) {
  if (!active_) return;
  while (ns >= end_ - now_) {
    ns -= end_ - now_;
    now_ = end_;
    edges();
    if (poll) poll();
    auto next = exchange_(done_);
    step(next, false);
  }
  now_ += ns;
  edges();
  if (poll) poll();
}
uint32_t Runtime::randomWord() {
  randomState_ ^= randomState_ << 13;
  randomState_ ^= randomState_ >> 17;
  randomState_ ^= randomState_ << 5;
  return randomState_;
}
void Runtime::call() { advance(config()["halCallCostNs"].as<uint64_t>()); }
void Runtime::loopReturned() { advance(config()["loopCostNs"].as<uint64_t>()); }
int Runtime::pin(size_t device, const char* name) const {
  for (auto p : config()["devices"][device]["pins"].as<JsonArrayConst>())
    if (p["name"] == name) return p["gpio"].as<int>();
  return -1;
}
bool Runtime::enabled(size_t d) const {
  int p = pin(d, "XSHUT");
  return p < 0 || !written_[p] || levels_[p];
}
int Runtime::route(uint8_t address, int sda, int scl, const char* kind) const {
  int found = -1;
  for (size_t i = 0; i < deviceCount(); ++i) {
    auto d = config()["devices"][i];
    if (addresses_[i] != address || pin(i, "SDA") != sda || pin(i, "SCL") != scl || !enabled(i))
      continue;
    // Collisions are electrical, even when the caller expects another device kind.
    if (found >= 0) return -1;
    found = static_cast<int>(i);
    if (kind && d["kind"] != kind) return -1;
  }
  return found;
}
void Runtime::mode(uint8_t pin, uint8_t mode) {
  modes_[pin] = mode;
  if (mode == 1 || mode == 5) {
    written_[pin] = false;
    if (mode == 5) levels_[pin] = true;
    for (size_t d = 0; d < deviceCount(); ++d)
      if (this->pin(d, "XSHUT") == pin) levels_[pin] = true;
  }
}
void Runtime::write(uint8_t pin, bool level) {
  if (!written_[pin] || levels_[pin] != level) {
    auto a = done_["message"]["gpioWrites"].as<JsonArray>();
    if (a.size() >= 4096) throw std::runtime_error("GPIO output buffer full");
    auto e = a.add<JsonObject>();
    e["gpio"] = pin;
    e["tUs"] = now_ / 1000;
    e["level"] = level;
  }
  written_[pin] = true;
  levels_[pin] = level;
  if (!level)
    for (size_t i = 0; i < deviceCount(); ++i)
      if (this->pin(i, "XSHUT") == pin) addresses_[i] = config()["devices"][i]["defaultI2cAddress"];
}
bool Runtime::read(uint8_t pin) {
  edges();
  return levels_[pin];
}
void Runtime::pwm(uint8_t pin, uint32_t period, uint32_t pulse) {
  if (periods_[pin] == period && pulses_[pin] == pulse) return;
  periods_[pin] = period;
  pulses_[pin] = pulse;
  auto a = done_["message"]["pwm"].as<JsonArray>();
  for (auto p : a)
    if (p["gpio"] == pin) {
      p["periodUs"] = period;
      p["pulseUs"] = pulse;
      return;
    }
  auto p = a.add<JsonObject>();
  p["gpio"] = pin;
  p["periodUs"] = period;
  p["pulseUs"] = pulse;
}
void Runtime::serial(const uint8_t* data, size_t size) {
  auto a = done_["message"]["serialTx"].as<JsonArray>();
  for (size_t i = 0; i < size; ++i) {
    if (serialCount_ == 16384) {
      advance(end_ - now_);
      a = done_["message"]["serialTx"].as<JsonArray>();
    }
    a.add(data[i]);
    ++serialCount_;
  }
}
JsonObject Runtime::netEvent() {
  auto a = done_["message"]["netEvents"].as<JsonArray>();
  if (a.size() >= 4096) throw std::runtime_error("network event buffer full");
  return a.add<JsonObject>();
}
void Runtime::log(const char* level, const std::string& text) {
  auto a = done_["message"]["logs"].as<JsonArray>();
  if (a.size() < 256) {
    auto l = a.add<JsonObject>();
    l["level"] = level;
    l["text"] = text.substr(0, 1024);
  }
}
int runFirmware(void (*setup)(), void (*loop)()) {
  std::signal(SIGPIPE, SIG_IGN);
  int fd = -1;
  try {
    const char* env = std::getenv("RCSIM_SOCKET");
    if (!env || !validSocketPath(env))
      throw std::runtime_error("RCSIM_SOCKET must be a /tmp path shorter than 100 bytes");
    fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) throw std::runtime_error("cannot create sim socket");
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    std::strcpy(addr.sun_path, env);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0)
      throw std::runtime_error("cannot connect sim socket");
    static const bool registered = std::atexit(firmwareExit) == 0;
    if (!registered) throw std::runtime_error("cannot register firmware exit handler");
    exitSocket = fd;
    JsonDocument hello;
    hello["type"] = "HELLO";
    hello["message"]["protocolVersion"] = 1;
    hello["message"]["halVersion"] = version();
    send(fd, hello);
    auto config = receive(fd);
    if (config["type"] == "BYE") throw EndRun(config["message"]["message"].as<std::string>());
    if (config["type"] != "CONFIG") throw ProtocolError("expected CONFIG");
    if (config["message"]["protocolVersion"] != 1 || config["message"]["tickUs"] == 0)
      throw ProtocolError("invalid CONFIG");
    auto first = receive(fd);
    runtime().start(config, first, [fd](const JsonDocument& done) {
      send(fd, done);
      return receive(fd);
    });
    setup();
    while (true) {
      loop();
      runtime().loopReturned();
    }
  } catch (const EndRun& e) {
    std::fprintf(stderr, "hal: sim stopped: %s\n", e.what());
    exitSocket = -1;
    if (fd >= 0) ::close(fd);
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "hal: %s\n", e.what());
    if (fd >= 0) {
      try {
        JsonDocument bye;
        bye["type"] = "BYE";
        bye["message"]["reason"] =
            dynamic_cast<const ProtocolError*>(&e) ? "malformed" : "firmware-exit";
        bye["message"]["message"] = std::string(e.what()).substr(0, 1024);
        send(fd, bye);
      } catch (...) {
      }
      ::close(fd);
    }
    exitSocket = -1;
    return 1;
  }
}
}  // namespace rcsim::hal
