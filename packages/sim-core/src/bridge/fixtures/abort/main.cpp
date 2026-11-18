// Prints, then aborts after 50 ms of sim time.
#include <Arduino.h>
#include <cstdio>
#include <cstdlib>

void setup() { Serial.begin(115200); }

void loop() {
  Serial.println("about to abort");
  delay(50);
  fprintf(stderr, "fatal: the sketch gave up\n");
  fflush(stderr);
  abort();
}
