#pragma once
#include <memory>

#include "Arduino.h"

#define WL_IDLE_STATUS 0
#define WL_DISCONNECTED 6
#define WL_CONNECTED 3
#define WIFI_STA 1
class IPAddress {
 public:
  IPAddress() = default;
  IPAddress(uint8_t a, uint8_t b, uint8_t c, uint8_t d) : bytes_{a, b, c, d} {}
  explicit IPAddress(uint32_t address);
  bool fromString(const char* address);
  String toString() const;
  uint8_t operator[](int index) const { return bytes_[index]; }
  operator uint32_t() const;

 private:
  uint8_t bytes_[4]{};
};
namespace rcsim::hal {
struct Socket;
}
class WiFiClient : public Stream {
 public:
  WiFiClient() = default;
  explicit WiFiClient(std::shared_ptr<rcsim::hal::Socket> socket);
  int connect(const char* host, uint16_t port);
  int connect(IPAddress host, uint16_t port);
  uint8_t connected();
  explicit operator bool() const;
  using Print::write;
  using Stream::read;
  size_t write(const uint8_t* data, size_t size) override;
  int available() override;
  int read() override;
  int peek() override;
  void flush() override;
  void stop();
  IPAddress remoteIP() const;
  uint16_t remotePort() const;
  int setNoDelay(bool enabled);
  // Host descriptor for diagnostics/readiness; observing it does not advance sim time.
  int fd() const;

 private:
  std::shared_ptr<rcsim::hal::Socket> socket_;
};
class WiFiServer {
 public:
  explicit WiFiServer(uint16_t port = 80, uint8_t maxClients = 4);
  void begin(uint16_t port = 0);
  WiFiClient available();
  WiFiClient accept();
  void end();
  void stop();
  void setNoDelay(bool enabled);
  uint16_t hostPort() const;
  // Host descriptor for diagnostics/readiness; observing it does not advance sim time.
  int fd() const;

 private:
  uint16_t port_;
  uint8_t maxClients_;
  bool noDelay_ = false;
  std::shared_ptr<rcsim::hal::Socket> socket_;
};
class WiFiClass {
 public:
  int begin(const char* ssid = nullptr, const char* password = nullptr);
  int status();
  IPAddress localIP();
  bool mode(int mode);
  bool disconnect(bool wifiOff = false, bool erase = false);

 private:
  bool connected_ = false;
};
extern WiFiClass WiFi;
