#pragma once
#include "Arduino.h"

class TwoWire {
 public:
  explicit TwoWire(uint8_t bus = 0) : bus_(bus) {}
  bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0);
  bool setClock(uint32_t frequency);
  void end();
  void beginTransmission(uint8_t address);
  size_t write(uint8_t data);
  size_t write(const uint8_t* data, size_t size);
  uint8_t endTransmission(bool stop = true);
  size_t requestFrom(uint8_t address, size_t size, bool stop = true);
  int available();
  int read();
  int route(uint8_t address, const char* kind = nullptr) const;

 private:
  uint8_t bus_;
  int sda_ = 21, scl_ = 22;
  uint8_t address_ = 0;
  bool begun_ = false;
};
extern TwoWire Wire;
extern TwoWire Wire1;
