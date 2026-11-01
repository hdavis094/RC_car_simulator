#!/bin/sh
# clang-format over hal's sources; `--check` only reports. Uses the pinned WASM
# build from devDependencies so every machine and CI runner formats identically.
set -eu
cd "$(dirname "$0")/.."
bin=node_modules/.bin/clang-format
if [ ! -x "$bin" ]; then
  echo "hal: $bin is missing; run pnpm install" >&2
  exit 1
fi
target=format
if [ "${1:-}" = "--check" ]; then target=format-check; fi
exec make --no-print-directory -s CLANG_FORMAT="$bin" "$target"
