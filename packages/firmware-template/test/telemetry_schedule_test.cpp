#include "telemetry_schedule.h"

#include <doctest.h>

using car::TelemetrySchedule;
TEST_CASE("telemetry deadlines keep their 20 Hz phase after late loop passes") {
  TelemetrySchedule schedule;
  CHECK_FALSE(schedule.take(49));
  CHECK(schedule.take(51));  // One millisecond late must not move the 100 ms deadline.
  CHECK_FALSE(schedule.take(99));
  CHECK(schedule.take(100));
  CHECK_FALSE(schedule.take(100));
  for (uint32_t deadline = 150; deadline <= 5000; deadline += 50) {
    CHECK_FALSE(schedule.take(deadline - 1));
    CHECK(schedule.take(deadline + 2));  // Repeated jitter never accumulates drift.
  }
  CHECK(schedule.take(5050));
}
TEST_CASE("missed telemetry slots are skipped without a catch-up burst or phase reset") {
  TelemetrySchedule schedule;
  CHECK(schedule.take(260));
  CHECK_FALSE(schedule.take(260));
  CHECK_FALSE(schedule.take(299));
  CHECK(schedule.take(300));
  CHECK(schedule.take(4408));  // Same late timestamp as the integration regression.
  CHECK_FALSE(schedule.take(4449));
  CHECK(schedule.take(4450));
}
TEST_CASE("telemetry cadence stays on phase through millis wrap") {
  TelemetrySchedule schedule(0xfffffff0U);
  CHECK_FALSE(schedule.take(33));
  CHECK(schedule.take(35));  // Wrapped deadline was 34.
  CHECK_FALSE(schedule.take(83));
  CHECK(schedule.take(84));
  CHECK_FALSE(schedule.take(133));
  CHECK(schedule.take(134));
}
