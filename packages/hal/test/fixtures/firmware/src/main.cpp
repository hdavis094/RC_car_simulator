#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <MPU6050.h>
#include <VL53L0X.h>
#include <WiFi.h>
#include <WiFiUdp.h>

Servo steering;
MPU6050 imu;
VL53L0X tof[3];
WiFiServer server(3333);
WiFiClient client;
WiFiUDP udp;
void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  for (int p = 16; p <= 18; ++p) {
    pinMode(p, OUTPUT_OPEN_DRAIN);
    digitalWrite(p, LOW);
  }
  for (int i = 0; i < 3; ++i) {
    digitalWrite(16 + i, HIGH);
    if (!tof[i].init()) Serial.print("INIT FAILED");
    tof[i].setAddress(0x30 + i);
    tof[i].setTimeout(100);
    tof[i].startContinuous();
  }
  imu.initialize();
  steering.attach(25, 1000, 2000);
  steering.write(90);
  auto t = millis();
  while (millis() - t < 50) {
  }
  Serial.printf("ranges:%u,%u,%u;", tof[0].readRangeContinuousMillimeters(),
                tof[1].readRangeContinuousMillimeters(), tof[2].readRangeContinuousMillimeters());
  WiFi.begin("sim", "password");
  server.begin();
  udp.begin(4210);
}
void loop() {
  auto t = micros();
  delay(100);
  auto elapsed = micros() - t;
  Serial.printf("delay:%lu;", elapsed);
  if (!client) client = server.available();
  if (client && client.available()) {
    JsonDocument command;
    auto line = client.readStringUntil('\n');
    if (!deserializeJson(command, line)) {
      JsonDocument response;
      response["echo"] = command["t"];
      response["mm"] = tof[0].readRangeContinuousMillimeters();
      serializeJson(response, client);
      client.println();
    }
  }
  int16_t ax, ay, az, gx, gy, gz;
  imu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
  steering.writeMicroseconds(1500);
}
