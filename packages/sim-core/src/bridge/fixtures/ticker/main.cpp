// Prints millis() once per second, scheduled from millis() itself so the
// spacing does not drift by the cost of the calls in between.
#include <Arduino.h>

void setup() { Serial.begin(115200); }

void loop() {
  static uint32_t next = 1000;
  if (millis() >= next) {
    Serial.println(millis());
    next += 1000;
  }
  delay(1);
}
