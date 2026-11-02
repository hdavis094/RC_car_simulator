#pragma once

#include <array>
#include <deque>
#include <functional>

#include "rcsim/protocol.h"

namespace rcsim::hal {
struct EndRun : std::runtime_error {
  using std::runtime_error::runtime_error;
};
class Runtime {
 public:
  using Exchange = std::function<JsonDocument(const JsonDocument&)>;
  void start(const JsonDocument& config, const JsonDocument& firstStep, Exchange exchange);
  void advance(uint64_t ns);
  void call();
  uint64_t nowNs() const { return now_; }
  uint64_t uptimeNs() const { return now_ - boot_; }
  void loopReturned();
  void mode(uint8_t pin, uint8_t mode);
  void write(uint8_t pin, bool level);
  bool read(uint8_t pin);
  void pwm(uint8_t pin, uint32_t periodUs, uint32_t pulseUs);
  void serial(const uint8_t* data, size_t size);
  std::deque<uint8_t>& serialRx() { return rx_; }
  JsonVariantConst config() const { return config_["message"]; }
  JsonVariantConst reading(size_t device) const { return readings_[device]; }
  size_t deviceCount() const { return addresses_.size(); }
  int pin(size_t device, const char* name) const;
  bool enabled(size_t device) const;
  uint8_t address(size_t device) const { return addresses_.at(device); }
  void address(size_t device, uint8_t value) { addresses_.at(device) = value; }
  int route(uint8_t address, int sda, int scl, const char* kind = nullptr) const;
  JsonObject netEvent();
  void log(const char* level, const std::string& text);
  JsonVariantConst faults() const { return faults_.as<JsonVariantConst>(); }
  bool active() const { return active_; }
  // Network pump is called at HAL boundaries and before STEP_DONE.
  std::function<void()> poll;

 private:
  void step(const JsonDocument& message, bool first);
  void edges();
  JsonDocument config_, step_, done_, readings_, faults_;
  Exchange exchange_;
  std::array<uint8_t, 256> modes_{};
  std::array<bool, 256> levels_{};
  std::array<bool, 256> written_{};
  std::array<uint32_t, 256> periods_{}, pulses_{};
  std::vector<uint8_t> addresses_;
  std::deque<uint8_t> rx_;
  uint64_t now_ = 0, boot_ = 0, end_ = 0, tick_ = 0;
  size_t edge_ = 0;
  bool active_ = false;
};
Runtime& runtime();
int runFirmware(void (*setup)(), void (*loop)());
}  // namespace rcsim::hal
