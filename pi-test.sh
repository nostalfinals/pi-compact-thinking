#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TEST_AGENT_DIR="$PROJECT_ROOT/test-agent-dir"
mkdir -p "$TEST_AGENT_DIR"
export PI_CODING_AGENT_DIR="$TEST_AGENT_DIR"

EXTENSION_ENTRY="$(node -p "require('$PROJECT_ROOT/package.json').pi.extensions[0]")"

exec pi -e "$PROJECT_ROOT/$EXTENSION_ENTRY" "$@"
