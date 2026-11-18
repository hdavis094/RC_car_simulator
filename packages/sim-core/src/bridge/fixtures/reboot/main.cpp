// Reports its uptime at boot and every 100 ms after; a restart makes it start over.
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  Serial.printf("boot %lu\n", (unsigned long)millis());
}

void loop() {
  delay(100);
  Serial.printf("up %lu\n", (unsigned long)millis());
}
