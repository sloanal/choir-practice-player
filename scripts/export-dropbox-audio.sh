#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"
app_dir="$project_dir/.capture-cache/ChoirStreamExport.app"
mkdir -p "$app_dir/Contents/MacOS"
cp scripts/choir-stream-export-Info.plist "$app_dir/Contents/Info.plist"
swiftc -O -parse-as-library -module-cache-path /private/tmp/choir-swift-cache \
  scripts/choir-stream-export.swift -o "$app_dir/Contents/MacOS/ChoirStreamExport"
codesign --force --sign - "$app_dir"
open "$app_dir"
