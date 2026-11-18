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
WARNINGS := -Wall -Wextra -Wpedantic
# Library builds used by firmware tolerate new compiler warnings. Our own tests
# compile both tests and HAL with warnings promoted to errors.
ifneq ($(filter test %/hal_tests,$(MAKECMDGOALS)),)
WARNINGS += -Werror
endif
CPPFLAGS += -Iinclude -isystem third_party -isystem libraries/ArduinoJson
ALL_CXXFLAGS := -std=c++17 $(WARNINGS) $(CXXFLAGS) -MMD -MP

LIB_SRCS := $(wildcard src/*.cpp)
TEST_SRCS := $(wildcard test/*.cpp)
LIB_OBJS := $(LIB_SRCS:%.cpp=$(BUILD_DIR)/%.o)
TEST_OBJS := $(TEST_SRCS:%.cpp=$(BUILD_DIR)/%.o)

# The stamp records which compiler built BUILD_DIR. When the compiler's path,
# version or flags change, the stamp changes and every object is rebuilt, so a
# different compiler with the same name can never reuse stale objects.
COMPILER_ID := $(shell command -v $(CXX) 2>/dev/null) $(shell $(CXX) --version 2>&1 | head -n 1) | $(CXX) $(CPPFLAGS) $(ALL_CXXFLAGS)
COMPILER_STAMP := $(BUILD_DIR)/compiler.stamp

LIB := $(BUILD_DIR)/libhal.a
TEST_BIN := $(BUILD_DIR)/hal_tests

CLANG_FORMAT ?= clang-format
FORMAT_SRCS := $(wildcard include/*.h include/**/*.h src/*.cpp src/*.h test/*.cpp test/*.h test/fixtures/*/src/*.cpp)

.PHONY: all lib test clean format format-check FORCE

all: lib

lib: $(LIB)

$(LIB): $(LIB_OBJS)
	@mkdir -p $(dir $@)
	$(AR) rcs $@ $^

$(TEST_BIN): $(TEST_OBJS) $(LIB)
	$(CXX) $(ALL_CXXFLAGS) -o $@ $(TEST_OBJS) $(LIB)

$(COMPILER_STAMP): FORCE
	@mkdir -p $(dir $@)
	@printf '%s\n' '$(subst ','\'',$(COMPILER_ID))' > $@.new
	@if cmp -s $@.new $@; then rm $@.new; else mv $@.new $@; fi

$(BUILD_DIR)/%.o: %.cpp $(COMPILER_STAMP)
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
