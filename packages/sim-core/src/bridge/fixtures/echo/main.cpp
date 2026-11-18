// Echoes Serial input back, prefixed with the millis() it was read at.
#include <Arduino.h>

void setup() { Serial.begin(115200); }

void loop() {
  while (Serial.available()) {
    int c = Serial.read();
    Serial.printf("[%lu]%c\n", (unsigned long)millis(), c);
  }
  delay(1);
}
