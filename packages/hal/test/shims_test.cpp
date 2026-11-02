#include "ESP32Servo.h"
#include "MPU6050.h"
#include "VL53L0X.h"
#include "fake_sim.h"

using hal_test::FakeSim;
TEST_CASE("three VL53L0X sensors require XSHUT sequencing and keep distinct addresses") {
  FakeSim sim;
  sim.start();
  CHECK_FALSE(Wire.begin(19, 22));
  CHECK(Wire.begin(21, 22));
  VL53L0X sensors[3];
  CHECK_FALSE(sensors[0].init());
  for (int p : {16, 17, 18}) {
    pinMode(p, OUTPUT_OPEN_DRAIN);
    digitalWrite(p, LOW);
  }
  for (int i = 0; i < 3; ++i) {
    digitalWrite(16 + i, HIGH);
    CHECK(sensors[i].init());
    sensors[i].setAddress(0x30 + i);
    CHECK(sensors[i].getAddress() == 0x30 + i);
    sensors[i].startContinuous();
  }
  CHECK(sensors[0].readRangeContinuousMillimeters() == 812);
  CHECK(sensors[1].readRangeContinuousMillimeters() == 1200);
  CHECK(sensors[2].readRangeContinuousMillimeters() == 640);
  Wire.beginTransmission(0x31);
  CHECK(Wire.endTransmission() == 0);
  digitalWrite(17, LOW);
  Wire.beginTransmission(0x31);
  CHECK(Wire.endTransmission() == 2);
  digitalWrite(17, HIGH);
  VL53L0X rebooted;
  CHECK(rebooted.init());
  sensors[1].setTimeout(2);
  CHECK(sensors[1].readRangeContinuousMillimeters() == 65535);
  CHECK(sensors[1].timeoutOccurred());
  CHECK_FALSE(sensors[1].timeoutOccurred());
}
TEST_CASE("VL53L0X reports out of range without a timeout") {
  FakeSim sim;
  sim.prepare = [](JsonDocument& d) { d["message"]["readings"][0]["status"] = "no-target"; };
  sim.start();
  Wire.begin();
  digitalWrite(17, LOW);
  digitalWrite(18, LOW);
  VL53L0X sensor;
  CHECK(sensor.init());
  CHECK(sensor.readRangeContinuousMillimeters() == 8190);
  CHECK_FALSE(sensor.timeoutOccurred());
}
TEST_CASE("MPU6050 converts SI readings to configured raw full-scale ranges") {
  FakeSim sim;
  sim.start();
  Wire.begin();
  MPU6050 imu;
  imu.initialize();
  CHECK(imu.testConnection());
  int16_t ax, ay, az, gx, gy, gz;
  imu.getMotion6(&ax, &ay, &az, &gx, &gy, &gz);
  CHECK(ax == 0);
  CHECK(ay == 0);
  CHECK(az == 16384);
  CHECK(gx == 0);
  CHECK(gy == 0);
  CHECK(gz == 7510);
  imu.setFullScaleAccelRange(MPU6050_ACCEL_FS_4);
  imu.setFullScaleGyroRange(MPU6050_GYRO_FS_500);
  imu.getAcceleration(&ax, &ay, &az);
  CHECK(az == 8192);
  imu.getRotation(&gx, &gy, &gz);
  CHECK(gz == 3755);
  imu.setDLPFMode(MPU6050_DLPF_BW_42);
  imu.setRate(4);
  CHECK(imu.getDLPFMode() == 3);
  CHECK(imu.getRate() == 4);
  imu.setSleepEnabled(true);
  imu.getAcceleration(&ax, &ay, &az);
  CHECK(az == 0);
}
TEST_CASE("Servo maps angle and explicit microseconds to PWM and stops on detach") {
  FakeSim sim;
  sim.start();
  Servo servo;
  CHECK(servo.attach(25, 1000, 2000));
  servo.write(90);
  CHECK(servo.readMicroseconds() == 1500);
  servo.write(180);
  CHECK(servo.readMicroseconds() == 2000);
  servo.writeMicroseconds(500);
  CHECK(servo.readMicroseconds() == 1000);
  delay(1);
  auto pwm = sim.done[0]["message"]["pwm"];
  REQUIRE(pwm.size() == 1);
  CHECK(pwm[0]["pulseUs"] == 1000);
  servo.detach();
  delay(1);
  CHECK(sim.done[1]["message"]["pwm"][0]["periodUs"] == 0);
}
