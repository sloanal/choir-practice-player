#!/usr/bin/env bash
# Pinned, project-local Rubber Band build. No global package modifications.
set -euo pipefail
audio_root="$(cd "$(dirname "$0")/.." && pwd)"
audio_tools="$audio_root/.audio-work/tools"
mkdir -p "$audio_tools"
archive="$audio_tools/rubberband-v4.0.0.tar.gz"
if [[ ! -f "$archive" ]]; then
  curl --fail --location --retry 3 https://github.com/breakfastquay/rubberband/archive/refs/tags/v4.0.0.tar.gz -o "$archive"
fi
expected=24300f48a8014b7c863b573a9647e61b1b19b37875e2cdd92005e64c6424d266
actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)"
[[ "$actual" == "$expected" ]] || { echo 'Rubber Band archive checksum mismatch' >&2; exit 1; }
tar -xzf "$archive" -C "$audio_tools"
source_file="$audio_tools/rubberband-4.0.0/single/RubberBandSingle.cpp"
if [[ "$(uname -s)" == Darwin ]]; then
  c++ -O3 -std=c++11 -dynamiclib "$source_file" -framework Accelerate -o "$audio_tools/librubberband.dylib"
else
  c++ -O3 -std=c++11 -shared -fPIC "$source_file" -o "$audio_tools/librubberband.so"
fi
echo 'Rubber Band 4.0.0 is ready in .audio-work/tools.'
