// Sweeps the steering servo as a triangle wave from neutral (1500 us) up to
// 1900, down to 1100 and back, period 4 s, one write every 20 ms of sim time.
#include <Arduino.h>
#include <ESP32Servo.h>

Servo steering;

void setup() {
  Serial.begin(115200);
  steering.attach(25, 1000, 2000);
  steering.writeMicroseconds(1500);
}

void loop() {
  uint32_t phase = (millis() + 1000) % 4000;
  uint32_t ramp = phase < 2000 ? phase : 4000 - phase;
  uint32_t pulse = 1100 + ramp * 800 / 2000;
  steering.writeMicroseconds(pulse);
  Serial.println(pulse);
  delay(20);
}
