#!/usr/bin/env bash
# Run a command; if it fails, publish the key error lines as a GitHub annotation so the
# failure is readable from the public checks API, not only from the raw (auth-only) log.
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  summary=$(grep -E '^(error|warning: unused|thread .* panicked|---- |failures:|  left:|  right:|expected `)|-->|panicked at' -A6 "$log" | head -80)
  [ -z "$summary" ] && summary=$(tail -40 "$log")
  summary=${summary//'%'/'%25'}; summary=${summary//$'\r'/'%0D'}; summary=${summary//$'\n'/'%0A'}
  echo "::error title=${title}::${summary}"
fi
exit "$status"
