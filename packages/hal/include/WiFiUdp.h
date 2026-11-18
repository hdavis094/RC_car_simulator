#pragma once
#include <vector>

#include "WiFi.h"

class WiFiUDP : public Stream {
 public:
  uint8_t begin(uint16_t port);
  void stop();
  int beginPacket(const char* host, uint16_t port);
  int beginPacket(IPAddress host, uint16_t port);
  int endPacket();
  int parsePacket();
  using Print::write;
  using Stream::read;
  size_t write(const uint8_t* data, size_t size) override;
  int available() override;
  int read() override;
  int peek() override;
  void flush() override;
  IPAddress remoteIP() const;
  uint16_t remotePort() const;

 private:
  friend struct rcsim::hal::NetworkAccess;
  std::shared_ptr<rcsim::hal::Socket> socket_;
  std::string host_;
  uint16_t port_ = 0;
  std::vector<uint8_t> packet_;
};
