#include "rcsim/hal_version.h"

#include <doctest.h>

#include <cstring>

TEST_CASE("hal reports a version") { CHECK(std::strcmp(rcsim::hal::version(), "0.0.0") == 0); }
