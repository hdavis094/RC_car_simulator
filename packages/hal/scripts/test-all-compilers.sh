#!/bin/sh
# Build and run hal's doctest suite once with every available compiler:
# $CXX (if set), g++ and clang++. On macOS both g++ and clang++ are Apple clang.
# Fails if any compiler fails, or if none is found.
set -u
cd "$(dirname "$0")/.."

compilers=""
for cxx in ${CXX:-} g++ clang++; do
  if command -v "$cxx" >/dev/null 2>&1; then
    case " $compilers " in *" $cxx "*) ;; *) compilers="$compilers $cxx" ;; esac
  fi
done
[ -n "$compilers" ] || { echo "hal: no C++ compiler found (tried \$CXX, g++, clang++)" >&2; exit 1; }

failed=""
for cxx in $compilers; do
  echo "== hal tests with $cxx ($("$cxx" --version 2>/dev/null | head -n 1))"
  make --no-print-directory -s CXX="$cxx" test || failed="$failed $cxx"
done

if [ -n "$failed" ]; then
  echo "hal: tests failed with:$failed" >&2
  exit 1
fi
