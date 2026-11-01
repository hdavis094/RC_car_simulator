# hal: the Arduino/ESP32 API for desktop (sim) builds.
#
#   make            build build/<compiler>/libhal.a
#   make test       build and run the doctest suite
#   make CXX=clang++ test
#
# The compiler is $CXX, falling back to c++ (AGENTS.md → Portability).

ifeq ($(origin CXX),default)
CXX := c++
endif

BUILD_DIR ?= build/$(notdir $(firstword $(CXX)))

CXXFLAGS ?= -O1 -g
WARNINGS := -Wall -Wextra -Wpedantic -Werror
CPPFLAGS += -Iinclude -isystem third_party
ALL_CXXFLAGS := -std=c++17 $(WARNINGS) $(CXXFLAGS) -MMD -MP

LIB_SRCS := $(wildcard src/*.cpp)
TEST_SRCS := $(wildcard test/*.cpp)
LIB_OBJS := $(LIB_SRCS:%.cpp=$(BUILD_DIR)/%.o)
TEST_OBJS := $(TEST_SRCS:%.cpp=$(BUILD_DIR)/%.o)

LIB := $(BUILD_DIR)/libhal.a
TEST_BIN := $(BUILD_DIR)/hal_tests

CLANG_FORMAT ?= clang-format
FORMAT_SRCS := $(wildcard include/*.h include/**/*.h src/*.cpp src/*.h test/*.cpp test/*.h)

.PHONY: all lib test clean format format-check

all: lib

lib: $(LIB)

$(LIB): $(LIB_OBJS)
	@mkdir -p $(dir $@)
	$(AR) rcs $@ $^

$(TEST_BIN): $(TEST_OBJS) $(LIB)
	$(CXX) $(ALL_CXXFLAGS) -o $@ $(TEST_OBJS) $(LIB)

$(BUILD_DIR)/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CPPFLAGS) $(ALL_CXXFLAGS) -c $< -o $@

test: $(TEST_BIN)
	./$(TEST_BIN)

clean:
	rm -rf build

format:
	$(CLANG_FORMAT) -i $(FORMAT_SRCS)

format-check:
	$(CLANG_FORMAT) --dry-run --Werror $(FORMAT_SRCS)

-include $(LIB_OBJS:.o=.d) $(TEST_OBJS:.o=.d)
