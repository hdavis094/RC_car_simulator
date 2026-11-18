#include <Arduino.h>
#include <ArduinoJson.h>
#include <ESP32Servo.h>
#include <MPU6050.h>
#include <VL53L0X.h>
#include <WiFi.h>

#include <array>

#if defined(ARDUINO_ARCH_ESP32)
#include <lwip/opt.h>
#include <lwip/sockets.h>
#endif

#include "avoidance.h"
#include "car_config.h"
#include "commands.h"
#include "control.h"
#include "outbound.h"

namespace {
// Initial v1 tuning; P2-01 retunes against the full sim. SI at the sim edge;
// these thresholds stay in mm because the sensor library reports mm.
constexpr car::AvoidanceTuning kAvoidance = [] {
  car::AvoidanceTuning tuning{};
  tuning.cruiseThrottle = 0.28F;
  tuning.slowThrottle = 0.12F;
  tuning.reverseThrottle = -0.18F;
  tuning.slowMm = 900;
  tuning.blockedMm = 250;
  tuning.clearMm = 325;  // Leave blocked state with 75 mm hysteresis.
  tuning.sideMm = 700;
  tuning.steerGain = 1.0F / 450.0F;  // Per mm.
  tuning.stopMs = 300;
  tuning.reverseMs = 600;
  return tuning;
}();
constexpr uint32_t kEscArmingMs = 3000;  // Matches the default ESC part definition.
constexpr uint32_t kSensorPeriodMs = 50;
constexpr uint16_t kSensorTimeoutMs = 20;
constexpr uint32_t kTelemetryPeriodMs = 50;
constexpr uint32_t kWifiStatusPeriodMs = 1000;
constexpr size_t kReceiveBudget = 256;      // Bound work so a flood cannot starve safety/telemetry.
constexpr char kCarName[] = "Default car";  // Keep in sync with car.json's name.
constexpr char kFirmwareVersion[] = "0.1.0";
#ifndef CAR_WIFI_SSID
#define CAR_WIFI_SSID "DonkeyCar"
#endif
#ifndef CAR_WIFI_PASSWORD
#define CAR_WIFI_PASSWORD "change-me"
#endif
constexpr std::array<int, 3> kXshut{TOF_LEFT_XSHUT_PIN, TOF_CENTRE_XSHUT_PIN, TOF_RIGHT_XSHUT_PIN};
constexpr std::array<uint8_t, 3> kAddress{TOF_LEFT_I2C_ADDR, TOF_CENTRE_I2C_ADDR,
                                          TOF_RIGHT_I2C_ADDR};
static_assert(TOF_LEFT_SDA_PIN == TOF_CENTRE_SDA_PIN && TOF_LEFT_SDA_PIN == TOF_RIGHT_SDA_PIN &&
                  TOF_LEFT_SDA_PIN == IMU_SDA_PIN && TOF_LEFT_SCL_PIN == TOF_CENTRE_SCL_PIN &&
                  TOF_LEFT_SCL_PIN == TOF_RIGHT_SCL_PIN && TOF_LEFT_SCL_PIN == IMU_SCL_PIN,
              "Starter firmware expects the sensors on one I2C bus");
Servo steering, esc;
VL53L0X tof[3];
MPU6050 imu(IMU_I2C_ADDR);
WiFiServer server(3333);
WiFiClient client;
car::ControlState control;
car::AvoidanceState avoidance;
car::Actuation automatic, applied;
car::CommandLine line;
std::array<car::Distance, 3> distances{};
std::array<bool, 3> sensorReady{};
uint32_t armStartedMs = 0, lastSensorMs = 0, lastTelemetryMs = 0, lastWifiStatusMs = 0;
bool escArmed = false;
bool listening = false, failsafeLogged = false, armingLogged = false, imuReady = false;

uint32_t nowMs() { return static_cast<uint32_t>(millis()); }
bool armed(uint32_t now) {
  escArmed = car::armingComplete(escArmed, armStartedMs, now, kEscArmingMs);
  return escArmed;
}
void writeOutputs() {
  const uint32_t now = nowMs();
  control = car::updateSafety(control, now);
  applied = car::output(control, now, armed(now), automatic);
  steering.writeMicroseconds(car::pulseUs(applied.steer, 1000, 1500, 2000));
  esc.writeMicroseconds(car::pulseUs(applied.throttle, 1000, 1500, 2000));
}
void sendDocument(const JsonDocument& document) {
  car::sendDocument(document, writeOutputs, [](const uint8_t* bytes, size_t size) {
    if (!client.connected()) return car::SendResult::Dropped;
#if defined(ARDUINO_ARCH_ESP32)
    const auto result = car::trySendSocket(client.fd(), bytes, size);
#else
    // Local HAL fallback: write() only enqueues and never waits (wifi.cpp:195-205,
    // 320-323). Keep its sim-time latency/loss queues; do not bypass them via fd().
    const size_t written = client.write(bytes, size);
    const auto result = written == size ? car::SendResult::Sent
                                       : (written == 0 ? car::SendResult::Dropped
                                                       : car::SendResult::Disconnect);
#endif
    if (result == car::SendResult::Disconnect) client.stop();
    return result;
  });
}
void logMessage(const char* message) {
  Serial.println(message);
  JsonDocument document;
  document["t"] = "log";
  document["msg"] = message;
  sendDocument(document);
}
void hello() {
  JsonDocument document;
  document["t"] = "hello";
  document["name"] = kCarName;
  document["fw"] = kFirmwareVersion;
  document["proto"] = 1;
  sendDocument(document);
}
void serviceControl() {
  if (!listening && CAR_WIFI_ENABLED && WiFi.status() == WL_CONNECTED) {
    server.begin();
    listening = true;
    logMessage("control server listening on port 3333");
  }
  if (!listening) return;
  WiFiClient incoming = server.accept();
  if (incoming) {
    client.stop();
    client = incoming;
#if defined(ARDUINO_ARCH_ESP32) && LWIP_SO_LINGER
    // If enabled in the board SDK, avoid waiting for pending TCP data on close.
    // Stock builds may disable this option, so sending never relies on it.
    // https://github.com/espressif/esp-lwip/blob/fa4dffdfac52587a26c1f29258376df750cf8474/src/api/api_msg.c#L1024-L1035
    linger abortive{1, 0};
    if (setsockopt(client.fd(), SOL_SOCKET, SO_LINGER, &abortive, sizeof(abortive)) != 0) {
      client.stop();  // This newly accepted socket has never sent any bytes.
      return;
    }
#endif
    client.setNoDelay(true);
    control = car::newConnection(control);
    line.reset();
    hello();
  }
  for (size_t count = 0; count < kReceiveBudget && client.available(); ++count) {
    const int byte = client.read();
    if (byte < 0) break;
    const auto result = line.push(static_cast<char>(byte));
    if (result == car::CommandLine::Result::TooLong) {
      logMessage("discarded control line longer than 4096 bytes");
    } else if (result == car::CommandLine::Result::Ready) {
      car::Command command;
      if (!car::parseCommand(line.data(), line.size(), command)) {
        logMessage("ignored invalid control command");
        continue;
      }
      control = car::applyCommand(control, command, nowMs());
      // E-stop is reflected in PWM before any sensor reads or telemetry work.
      writeOutputs();
    }
  }
}
void readSensors() {
  for (size_t i = 0; i < distances.size(); ++i) {
    if (!sensorReady[i]) {
      distances[i] = {};
      continue;
    }
    const uint16_t mm = tof[i].readRangeContinuousMillimeters();
    const bool valid = !tof[i].timeoutOccurred();
    // Pololu reports out-of-range as 8190/8191. The wire protocol uses zero.
    distances[i] = {static_cast<uint16_t>(mm >= 8190 ? 0 : mm), valid};
  }
}
void telemetry() {
  JsonDocument document;
  document["t"] = "telemetry";
  document["ms"] = nowMs();
  document["mode"] = control.mode == car::Mode::Manual ? "manual" : "auto";
  document["estop"] = control.estop;
  document["throttle"] = applied.throttle;
  document["steer"] = applied.steer;
  auto ranges = document["tof_mm"].to<JsonArray>();
  for (auto distance : distances) ranges.add(distance.valid ? distance.mm : 0);
  const float batteryMv = float(analogReadMilliVolts(BATTERY_SENSE_OUT_PIN)) *
                          (BATTERY_SENSE_R1_OHM + BATTERY_SENSE_R2_OHM) / BATTERY_SENSE_R2_OHM;
  document["batt_mv"] = static_cast<unsigned>(batteryMv + 0.5F);
  if (imuReady) {
    int16_t x, y, z;
    imu.getRotation(&x, &y, &z);
    document["yaw_dps"] = float(z) / 131.0F;  // Gyro FS=250 deg/s; local +Z is up.
  }
  sendDocument(document);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Serial.println("Donkey Car starter firmware 0.1.0");
  steering.setPeriodHertz(50);
  steering.attach(STEERING_SIGNAL_PIN, 1000, 2000);
  steering.writeMicroseconds(1500);
  esc.setPeriodHertz(50);
  esc.attach(ESC_SIGNAL_PIN, 1000, 2000);
  esc.writeMicroseconds(1500);
  armStartedMs = nowMs();

  Wire.begin(TOF_LEFT_SDA_PIN, TOF_LEFT_SCL_PIN);
  for (int pin : kXshut) {
    pinMode(pin, OUTPUT_OPEN_DRAIN);
    digitalWrite(pin, LOW);
  }
  delay(2);
  for (size_t i = 0; i < kXshut.size(); ++i) {
    // Release to the carrier's 2.8 V pull-up; never drive XSHUT push-pull high.
    pinMode(kXshut[i], INPUT);
    delay(10);
    tof[i].setTimeout(kSensorTimeoutMs);
    sensorReady[i] = tof[i].init();
    if (sensorReady[i]) {
      tof[i].setAddress(kAddress[i]);
      tof[i].startContinuous(kSensorPeriodMs);
    } else {
      // Keep a failed part off the default address so the next can initialize.
      pinMode(kXshut[i], OUTPUT_OPEN_DRAIN);
      digitalWrite(kXshut[i], LOW);
      logMessage("ToF initialization failed; auto mode will stop");
    }
  }
  imu.initialize();
  imu.setFullScaleGyroRange(MPU6050_GYRO_FS_250);
  imuReady = imu.testConnection();
  if (!imuReady) logMessage("MPU6050 initialization failed");
  analogReadResolution(12);
  if (CAR_WIFI_ENABLED) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(CAR_WIFI_SSID, CAR_WIFI_PASSWORD);
  }
  // Arming is a time gate, so networking remains responsive while neutral is held.
  if (CAR_WIFI_ENABLED) {
    Serial.println(
        "Wi-Fi: connecting to configured SSID; if this persists, set CAR_WIFI_SSID and "
        "CAR_WIFI_PASSWORD (default password: change-me)");
  } else {
    Serial.println("Wi-Fi: disabled in car config");
  }
  serviceControl();
}
void loop() {
  // Update safety/PWM before accept, hello, logs or any other network send.
  writeOutputs();
  serviceControl();
  uint32_t now = nowMs();
  if (uint32_t(now - lastSensorMs) >= kSensorPeriodMs) {
    readSensors();
    lastSensorMs = nowMs();
  }
  now = nowMs();
  if (control.mode == car::Mode::Auto && !control.estop && armed(now)) {
    const auto decision = car::avoid(avoidance, distances, now, kAvoidance);
    avoidance = decision.state;
    automatic = decision.drive;
  } else {
    avoidance = {};
    automatic = {};
  }
  writeOutputs();
  const bool failsafe = control.hasDrive && car::failsafeDue(control, now);
  if (failsafe && !failsafeLogged) logMessage("failsafe: no drive for 500 ms");
  failsafeLogged = failsafe;
  if (armed(now) && !armingLogged) {
    logMessage("ESC armed after 3000 ms neutral");
    armingLogged = true;
  }
  if (uint32_t(now - lastWifiStatusMs) >= kWifiStatusPeriodMs) {
    if (!CAR_WIFI_ENABLED) {
      Serial.println("Wi-Fi: disabled in car config");
    } else if (WiFi.status() == WL_CONNECTED) {
      Serial.print("Wi-Fi: connected, IP ");
      Serial.println(WiFi.localIP());
    } else {
      Serial.println(
          "Wi-Fi: NOT CONNECTED; check CAR_WIFI_SSID / CAR_WIFI_PASSWORD "
          "(default: change-me)");
    }
    lastWifiStatusMs = now;
  }
  if (uint32_t(now - lastTelemetryMs) >= kTelemetryPeriodMs) {
    telemetry();
    lastTelemetryMs = now;
  }
  delay(1);
}
