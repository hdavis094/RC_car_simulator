#!/bin/sh
# Build and run hal's doctest suite once per distinct available compiler:
# $CXX (falling back to c++), g++ and clang++. Names that report the same
# version (c++ and g++ on Linux; everything on macOS, which is Apple clang)
# run once. Fails if any compiler fails, or if none is found.
set -u
cd "$(dirname "$0")/.."

compilers=""
seen_versions=""
for cxx in "${CXX:-c++}" g++ clang++; do
  command -v "$cxx" >/dev/null 2>&1 || continue
  version=$("$cxx" --version 2>/dev/null | head -n 1)
  version=${version#* } # drop the program name: "g++ (GCC) 16.2" -> "(GCC) 16.2"
  case "$seen_versions" in *"|$version|"*) continue ;; esac
  seen_versions="$seen_versions|$version|"
  compilers="$compilers $cxx"
done
[ -n "$compilers" ] || { echo "hal: no C++ compiler found (tried \${CXX:-c++}, g++, clang++)" >&2; exit 1; }

failed=""
for cxx in $compilers; do
  echo "== hal tests with $cxx ($("$cxx" --version 2>/dev/null | head -n 1))"
  make --no-print-directory -s CXX="$cxx" test || failed="$failed $cxx"
done

if [ -n "$failed" ]; then
  echo "hal: tests failed with:$failed" >&2
  exit 1
fi
