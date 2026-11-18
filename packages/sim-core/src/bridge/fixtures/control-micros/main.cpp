// Like `control`, but reads every line that is waiting in one go and reports
// micros() and the line length: sensitive to when the bytes reached the socket.
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
  while (client && client.available()) {
    String line = client.readStringUntil('\n');
    Serial.printf("%lu %u\n", (unsigned long)micros(), (unsigned)line.length());
  }
  delay(1);
}
