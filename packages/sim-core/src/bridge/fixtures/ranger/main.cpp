// Brings up the three VL53L0X sensors one at a time (XSHUT 16..18, addresses
// 0x30..0x32) and prints their ranges every 100 ms.
#include <Arduino.h>
#include <VL53L0X.h>
#include <Wire.h>

VL53L0X tof[3];

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  for (int p = 16; p <= 18; ++p) {
    pinMode(p, OUTPUT_OPEN_DRAIN);
    digitalWrite(p, LOW);
  }
  for (int i = 0; i < 3; ++i) {
    digitalWrite(16 + i, HIGH);
    if (!tof[i].init()) Serial.println("INIT FAILED");
    tof[i].setAddress(0x30 + i);
    tof[i].startContinuous();
  }
}

void loop() {
  delay(100);
  Serial.printf("%u,%u,%u\n", tof[0].readRangeContinuousMillimeters(),
                tof[1].readRangeContinuousMillimeters(), tof[2].readRangeContinuousMillimeters());
}
