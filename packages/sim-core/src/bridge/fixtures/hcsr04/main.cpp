// HC-SR04 on TRIG 5, ECHO 18: triggers every 50 ms and prints the echo width.
#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  pinMode(5, OUTPUT);
  pinMode(18, INPUT);
  digitalWrite(5, LOW);
}

void loop() {
  digitalWrite(5, HIGH);
  delayMicroseconds(10);
  digitalWrite(5, LOW);
  unsigned long us = pulseIn(18, HIGH, 30000);
  Serial.printf("echo %lu\n", us);
  delay(50);
}
