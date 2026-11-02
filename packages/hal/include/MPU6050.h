#pragma once
#include "Wire.h"

#define MPU6050_ACCEL_FS_2 0
#define MPU6050_ACCEL_FS_4 1
#define MPU6050_ACCEL_FS_8 2
#define MPU6050_ACCEL_FS_16 3
#define MPU6050_GYRO_FS_250 0
#define MPU6050_GYRO_FS_500 1
#define MPU6050_GYRO_FS_1000 2
#define MPU6050_GYRO_FS_2000 3
#define MPU6050_DLPF_BW_256 0
#define MPU6050_DLPF_BW_188 1
#define MPU6050_DLPF_BW_98 2
#define MPU6050_DLPF_BW_42 3
#define MPU6050_DLPF_BW_20 4
#define MPU6050_DLPF_BW_10 5
#define MPU6050_DLPF_BW_5 6
class MPU6050 {
 public:
  explicit MPU6050(uint8_t address = 0x68, void* wire = nullptr);
  void initialize();
  bool testConnection();
  void getMotion6(int16_t* ax, int16_t* ay, int16_t* az, int16_t* gx, int16_t* gy, int16_t* gz);
  void getAcceleration(int16_t* x, int16_t* y, int16_t* z);
  void getRotation(int16_t* x, int16_t* y, int16_t* z);
  int16_t getTemperature();
  void setFullScaleAccelRange(uint8_t range);
  void setFullScaleGyroRange(uint8_t range);
  uint8_t getFullScaleAccelRange();
  uint8_t getFullScaleGyroRange();
  void setDLPFMode(uint8_t mode);
  uint8_t getDLPFMode();
  void setRate(uint8_t rate);
  uint8_t getRate();
  void setSleepEnabled(bool sleep);

 private:
  void motion(int16_t* x, int16_t* y, int16_t* z, bool gyro);
  uint8_t address_, accel_ = 0, gyro_ = 0, dlpf_ = 0, rate_ = 0;
  bool sleep_ = false;
  TwoWire* wire_;
};
