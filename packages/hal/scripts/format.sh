#!/bin/sh
# clang-format over hal's sources. `--check` only reports. Skips with a notice
# when clang-format is not installed (CI on Linux has it).
set -u
cd "$(dirname "$0")/.."
if ! command -v clang-format >/dev/null 2>&1; then
  echo "hal: clang-format not found, skipping C++ format check" >&2
  exit 0
fi
if [ "${1:-}" = "--check" ]; then exec make --no-print-directory -s format-check; fi
exec make --no-print-directory -s format
