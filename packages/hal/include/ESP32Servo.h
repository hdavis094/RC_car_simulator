#pragma once
#include "Arduino.h"

class Servo {
 public:
  int attach(int pin, int min = 544, int max = 2400);
  void detach();
  bool attached();
  void setPeriodHertz(int hertz);
  void write(int value);
  void writeMicroseconds(int value);
  int read();
  int readMicroseconds();

 private:
  int pin_ = -1, min_ = 544, max_ = 2400, pulse_ = 1500, hertz_ = 50;
};
class ESP32PWM {
 public:
  static void allocateTimer(int) {}
};
