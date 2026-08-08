#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
PYTHONPATH=sidecar python3 -m pytest sidecar/tests
