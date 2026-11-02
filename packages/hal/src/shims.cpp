#include "ESP32Servo.h"
#include "MPU6050.h"
#include "VL53L0X.h"
#include "rcsim/runtime.h"

using rcsim::hal::runtime;
TwoWire Wire;
TwoWire Wire1(1);
bool TwoWire::begin(int sda, int scl, uint32_t) {
  runtime().call();
  sda_ = sda < 0 ? (bus_ ? 25 : 21) : sda;
  scl_ = scl < 0 ? (bus_ ? 26 : 22) : scl;
  begun_ = false;
  for (size_t d = 0; d < runtime().deviceCount(); ++d) {
    if (runtime().pin(d, "SDA") == sda_ && runtime().pin(d, "SCL") == scl_) begun_ = true;
  }
  if (!begun_) runtime().log("error", "Wire.begin pins do not match any configured I2C bus");
  return begun_;
}
bool TwoWire::setClock(uint32_t frequency) {
  runtime().call();
  return frequency > 0;
}
void TwoWire::end() {
  runtime().call();
  begun_ = false;
}
int TwoWire::route(uint8_t address, const char* kind) const {
  return begun_ ? runtime().route(address, sda_, scl_, kind) : -1;
}
void TwoWire::beginTransmission(uint8_t address) {
  runtime().call();
  address_ = address;
}
size_t TwoWire::write(uint8_t) {
  runtime().call();
  return 1;
}
size_t TwoWire::write(const uint8_t*, size_t size) {
  runtime().call();
  return size;
}
uint8_t TwoWire::endTransmission(bool) {
  runtime().call();
  return route(address_) >= 0 ? 0 : 2;
}
size_t TwoWire::requestFrom(uint8_t, size_t, bool) {
  runtime().call();
  runtime().log("warn", "Wire register reads are unsupported; use the configured library shim");
  return 0;
}
int TwoWire::available() {
  runtime().call();
  return 0;
}
int TwoWire::read() {
  runtime().call();
  return -1;
}
int Servo::attach(int pin, int minimum, int maximum) {
  runtime().call();
  if (pin < 0 || pin > 255 || minimum <= 0 || maximum <= minimum) return 0;
  pin_ = pin;
  min_ = minimum;
  max_ = maximum;
  pulse_ = constrain(pulse_, min_, max_);
  runtime().pwm(static_cast<uint8_t>(pin_), 1000000 / hertz_, pulse_);
  return 1;
}
void Servo::detach() {
  runtime().call();
  if (pin_ >= 0) runtime().pwm(static_cast<uint8_t>(pin_), 0, 0);
  pin_ = -1;
}
bool Servo::attached() {
  runtime().call();
  return pin_ >= 0;
}
void Servo::setPeriodHertz(int hertz) {
  runtime().call();
  if (hertz > 0 && hertz <= 1000) hertz_ = hertz;
}
void Servo::write(int value) {
  runtime().call();
  pulse_ = value < 544 ? min_ + constrain(value, 0, 180) * (max_ - min_) / 180
                       : constrain(value, min_, max_);
  if (pin_ >= 0) runtime().pwm(static_cast<uint8_t>(pin_), 1000000 / hertz_, pulse_);
}
void Servo::writeMicroseconds(int value) {
  runtime().call();
  pulse_ = constrain(value, min_, max_);
  if (pin_ >= 0) runtime().pwm(static_cast<uint8_t>(pin_), 1000000 / hertz_, pulse_);
}
int Servo::read() {
  runtime().call();
  return (pulse_ - min_) * 180 / (max_ - min_);
}
int Servo::readMicroseconds() {
  runtime().call();
  return pulse_;
}
void VL53L0X::setBus(TwoWire* bus) {
  runtime().call();
  bus_ = bus ? bus : &Wire;
}
TwoWire* VL53L0X::getBus() {
  runtime().call();
  return bus_;
}
bool VL53L0X::init(bool) {
  runtime().call();
  return bus_->route(address_, "vl53l0x") >= 0;
}
void VL53L0X::setAddress(uint8_t address) {
  runtime().call();
  int d = bus_->route(address_, "vl53l0x");
  if (d >= 0 && address > 0 && address < 128) {
    runtime().address(d, address);
    address_ = address;
  }
}
uint8_t VL53L0X::getAddress() {
  runtime().call();
  return address_;
}
void VL53L0X::setTimeout(uint16_t timeout) {
  runtime().call();
  timeout_ = timeout;
}
uint16_t VL53L0X::getTimeout() {
  runtime().call();
  return timeout_;
}
void VL53L0X::startContinuous(uint32_t) {
  runtime().call();
  continuous_ = true;
}
void VL53L0X::stopContinuous() {
  runtime().call();
  continuous_ = false;
}
uint16_t VL53L0X::readRangeContinuousMillimeters() {
  auto& r = runtime();
  r.call();
  auto start = r.nowNs();
  while (true) {
    int d = bus_->route(address_, "vl53l0x");
    if (d >= 0 && !r.reading(d).isNull() && r.reading(d)["type"] == "distance") {
      auto reading = r.reading(d);
      return reading["status"] == "valid" ? reading["mm"].as<uint16_t>() : 8190;
    }
    if (timeout_ && r.nowNs() - start >= uint64_t(timeout_) * 1000000) {
      timedOut_ = true;
      return 65535;
    }
    r.call();
  }
}
uint16_t VL53L0X::readRangeSingleMillimeters() { return readRangeContinuousMillimeters(); }
bool VL53L0X::timeoutOccurred() {
  runtime().call();
  bool result = timedOut_;
  timedOut_ = false;
  return result;
}
MPU6050::MPU6050(uint8_t address, void* wire)
    : address_(address), wire_(wire ? static_cast<TwoWire*>(wire) : &Wire) {}
void MPU6050::initialize() {
  runtime().call();
  accel_ = gyro_ = 0;
  sleep_ = false;
}
bool MPU6050::testConnection() {
  runtime().call();
  return wire_->route(address_, "mpu6050") >= 0;
}
void MPU6050::motion(int16_t* x, int16_t* y, int16_t* z, bool gyro) {
  int d = wire_->route(address_, "mpu6050");
  auto r = d < 0 ? JsonVariantConst() : runtime().reading(d);
  const char* field = gyro ? "gyro" : "accel";
  double scale = gyro ? (32768.0 / (250 * (1 << gyro_))) * RAD_TO_DEG
                      : 32768.0 / (2 * (1 << accel_) * 9.80665);
  int16_t* outputs[] = {x, y, z};
  for (int i = 0; i < 3; ++i)
    if (outputs[i])
      *outputs[i] = sleep_ ? 0
                           : static_cast<int16_t>(constrain(
                                 std::lround(r[field][i].as<double>() * scale), -32768L, 32767L));
}
void MPU6050::getMotion6(int16_t* ax, int16_t* ay, int16_t* az, int16_t* gx, int16_t* gy,
                         int16_t* gz) {
  runtime().call();
  motion(ax, ay, az, false);
  motion(gx, gy, gz, true);
}
void MPU6050::getAcceleration(int16_t* x, int16_t* y, int16_t* z) {
  runtime().call();
  motion(x, y, z, false);
}
void MPU6050::getRotation(int16_t* x, int16_t* y, int16_t* z) {
  runtime().call();
  motion(x, y, z, true);
}
int16_t MPU6050::getTemperature() {
  runtime().call();
  int d = wire_->route(address_, "mpu6050");
  return d < 0 ? 0
               : static_cast<int16_t>(constrain(
                     std::lround((runtime().reading(d)["tempC"].as<double>() - 36.53) * 340),
                     -32768L, 32767L));
}
void MPU6050::setFullScaleAccelRange(uint8_t range) {
  runtime().call();
  accel_ = std::min<uint8_t>(range, 3);
}
void MPU6050::setFullScaleGyroRange(uint8_t range) {
  runtime().call();
  gyro_ = std::min<uint8_t>(range, 3);
}
uint8_t MPU6050::getFullScaleAccelRange() {
  runtime().call();
  return accel_;
}
uint8_t MPU6050::getFullScaleGyroRange() {
  runtime().call();
  return gyro_;
}
void MPU6050::setDLPFMode(uint8_t mode) {
  runtime().call();
  dlpf_ = mode;
}
uint8_t MPU6050::getDLPFMode() {
  runtime().call();
  return dlpf_;
}
void MPU6050::setRate(uint8_t rate) {
  runtime().call();
  rate_ = rate;
}
uint8_t MPU6050::getRate() {
  runtime().call();
  return rate_;
}
void MPU6050::setSleepEnabled(bool sleep) {
  runtime().call();
  sleep_ = sleep;
}
