// Spins without calling hal: never yields, so the sim sees a stall.
#include <Arduino.h>

void setup() {}

void loop() {
  volatile unsigned long n = 0;
  for (;;) n = n + 1;
}
