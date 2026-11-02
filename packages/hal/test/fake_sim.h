#pragma once
#include <doctest.h>

#include <fstream>

#include "rcsim/runtime.h"

namespace hal_test {
inline JsonDocument load(const char* path) {
  std::ifstream f(path);
  JsonDocument d;
  if (deserializeJson(d, f)) throw std::runtime_error("cannot read test JSON");
  return d;
}
inline JsonDocument makeStep(uint64_t tick, uint64_t originUs = 0) {
  JsonDocument d;
  d["type"] = "STEP";
  auto s = d["message"].to<JsonObject>();
  s["tick"] = tick;
  s["t0Us"] = originUs + tick * 1000;
  s["t1Us"] = originUs + (tick + 1) * 1000;
  for (auto name : {"readings", "gpioEdges", "serialRx"}) s[name].to<JsonArray>();
  return d;
}
struct FakeSim {
  JsonDocument config = load("../sim-protocol/vectors/config.json");
  std::vector<JsonDocument> done;
  uint64_t nextTick = 0;
  std::function<void(JsonDocument&)> prepare;
  FakeSim() {
    auto a = config["message"]["devices"].as<JsonArray>();
    for (int i = 0; i < 2; ++i) {
      auto d = a.add<JsonObject>();
      d.set(a[2]);
      d["instanceId"] = i ? "tof_right" : "tof_centre";
      d["targetI2cAddress"] = 0x31 + i;
      d["pins"][2]["gpio"] = 17 + i;
    }
  }
  JsonDocument next() {
    auto d = makeStep(nextTick++);
    auto a = d["message"]["readings"].as<JsonArray>();
    auto distance = [&](int device, int mm) {
      auto r = a.add<JsonObject>();
      r["device"] = device;
      r["tUs"] = nextTick > 1 ? (nextTick - 2) * 1000 : 0;
      r["type"] = "distance";
      r["mm"] = mm;
      r["status"] = "valid";
    };
    distance(2, 812);
    distance(6, 1200);
    distance(7, 640);
    auto r = a.add<JsonObject>();
    r["device"] = 3;
    r["tUs"] = 0;
    r["type"] = "imu";
    for (auto name : {"accel", "gyro"}) {
      auto v = r[name].to<JsonArray>();
      v.add(0);
      v.add(0);
      v.add(name[0] == 'a' ? 9.80665 : 1.0);
    }
    r["tempC"] = 24.5;
    r = a.add<JsonObject>();
    r["device"] = 5;
    r["tUs"] = 0;
    r["type"] = "analog";
    r["volts"] = 2.0625;
    if (prepare) prepare(d);
    return d;
  }
  void start() {
    nextTick = 0;
    done.clear();
    rcsim::hal::runtime().start(config, next(), [this](const JsonDocument& d) {
      done.push_back(rcsim::hal::decode(rcsim::hal::encode(d)));
      return next();
    });
  }
};
}  // namespace hal_test
