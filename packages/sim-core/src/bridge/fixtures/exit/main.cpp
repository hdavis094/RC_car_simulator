// Exits with status 3 after 20 ms.
#include <Arduino.h>
#include <cstdlib>

void setup() { Serial.begin(115200); }

void loop() {
  delay(20);
  exit(3);
}
