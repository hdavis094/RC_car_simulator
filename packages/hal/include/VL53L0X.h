#pragma once
#include "Wire.h"

class VL53L0X {
 public:
  void setBus(TwoWire* bus);
  TwoWire* getBus();
  bool init(bool io2v8 = true);
  void setAddress(uint8_t address);
  uint8_t getAddress();
  void setTimeout(uint16_t timeout);
  uint16_t getTimeout();
  void startContinuous(uint32_t periodMs = 0);
  void stopContinuous();
  uint16_t readRangeContinuousMillimeters();
  uint16_t readRangeSingleMillimeters();
  bool timeoutOccurred();

 private:
  TwoWire* bus_ = &Wire;
  uint8_t address_ = 0x29;
  uint16_t timeout_ = 0;
  bool timedOut_ = false, continuous_ = false;
};
