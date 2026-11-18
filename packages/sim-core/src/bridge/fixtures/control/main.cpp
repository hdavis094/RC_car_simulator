// A minimal control-protocol car: listens on 3333 and echoes each received
// line to Serial, so a scripted --control timeline is visible in the output.
#include <Arduino.h>
#include <WiFi.h>

WiFiServer server(3333);
WiFiClient client;

void setup() {
  Serial.begin(115200);
  WiFi.begin("sim", "password");
  server.begin();
}

void loop() {
  if (!client) client = server.available();
  if (client && client.available()) {
    String line = client.readStringUntil('\n');
    Serial.printf("[%lu] rx %s\n", (unsigned long)millis(), line.c_str());
  }
  delay(1);
}
