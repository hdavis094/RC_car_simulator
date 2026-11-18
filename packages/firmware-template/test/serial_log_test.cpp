#include "serial_log.h"

#include <doctest.h>

#include <string>

namespace {
struct SerialPort {
  int capacity = 0;
  size_t writes = 0;
  std::string bytes;
  int availableForWrite() const { return capacity; }
  size_t write(const uint8_t* data, size_t size) {
    REQUIRE(size <= static_cast<size_t>(capacity));
    ++writes;
    bytes.append(reinterpret_cast<const char*>(data), size);
    capacity -= static_cast<int>(size);
    return size;
  }
};
}  // namespace
TEST_CASE("Serial logs skip full or insufficient TX space and reserve CRLF in one write") {
  SerialPort serial;
  CHECK_FALSE(car::trySerialLine(serial, "ready"));
  CHECK(serial.writes == 0);
  serial.capacity = 6;  // Text fits, but CRLF would not.
  CHECK_FALSE(car::trySerialLine(serial, "ready"));
  CHECK(serial.writes == 0);
  serial.capacity = 7;
  CHECK(car::trySerialLine(serial, "ready"));
  CHECK(serial.writes == 1);
  CHECK(serial.bytes == "ready\r\n");
  CHECK_FALSE(car::trySerialLine(serial, "next"));
  CHECK(serial.writes == 1);
  serial.capacity = 1000;
  CHECK_FALSE(car::trySerialLine(serial, std::string(192, 'x').c_str()));
  CHECK(serial.writes == 1);
}
