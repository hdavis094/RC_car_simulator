// Drives the ESC (GPIO 26) the first time it boots only: neutral until it is
// armed, then a throttle pulse. A rebooted copy finds the flag file the first
// boot left in the working directory and attaches nothing, like firmware that
// does not set up its pins before something else has.
#include <Arduino.h>
#include <ESP32Servo.h>
#include <cstdio>

Servo esc;
bool drives = false;

void setup() {
  Serial.begin(115200);
  FILE* flag = fopen("booted.flag", "r");
  if (flag) {
    fclose(flag);
    return;
  }
  flag = fopen("booted.flag", "w");
  if (flag) fclose(flag);
  drives = true;
  esc.attach(26, 1000, 2000);
}

void loop() {
  if (drives) esc.writeMicroseconds(millis() < 3500 ? 1500 : 1600);
  delay(10);
}
