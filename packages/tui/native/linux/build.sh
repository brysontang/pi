#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compiler="${CC:-cc}"
wayland_scanner="${WAYLAND_SCANNER:-wayland-scanner}"

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Linux native helpers must be built on Linux" >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64)
        arch="x64"
        ;;
    aarch64|arm64)
        arch="arm64"
        ;;
    *)
        echo "Unsupported Linux architecture: $(uname -m)" >&2
        exit 1
        ;;
esac

if ! command -v "$compiler" >/dev/null 2>&1; then
    echo "Linux C compiler not found: $compiler" >&2
    exit 1
fi
if ! command -v "$wayland_scanner" >/dev/null 2>&1; then
    echo "wayland-scanner not found: $wayland_scanner" >&2
    exit 1
fi

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-tui-linux.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT

common_flags=(
    -std=c11
    -D_POSIX_C_SOURCE=200809L
    -Wall
    -Wextra
    -Werror
    -Os
    -flto
    -fPIC
    -fvisibility=hidden
    -fno-stack-protector
    -shared
    -nostdlib
    -Wl,--unresolved-symbols=ignore-all
    -Wl,--no-as-needed
    -Wl,-O2
    -Wl,--gc-sections
    -Wl,-s
    -Wl,-z,max-page-size=4096
)

"$wayland_scanner" client-header \
    "$script_dir/protocol/ext-data-control-v1.xml" \
    "$build_dir/ext-data-control-client-protocol.h"
"$wayland_scanner" private-code \
    "$script_dir/protocol/ext-data-control-v1.xml" \
    "$build_dir/ext-data-control-protocol.c"
"$wayland_scanner" client-header \
    "$script_dir/protocol/wlr-data-control-unstable-v1.xml" \
    "$build_dir/wlr-data-control-client-protocol.h"
"$wayland_scanner" private-code \
    "$script_dir/protocol/wlr-data-control-unstable-v1.xml" \
    "$build_dir/wlr-data-control-protocol.c"

wayland_output="$build_dir/linux-platform-wayland.node"
"$compiler" "${common_flags[@]}" \
    -I "$build_dir" \
    "$script_dir/src/linux-platform-wayland.c" \
    "$build_dir/ext-data-control-protocol.c" \
    "$build_dir/wlr-data-control-protocol.c" \
    -lwayland-client \
    -o "$wayland_output"

x11_output="$build_dir/linux-platform-x11.node"
"$compiler" "${common_flags[@]}" \
    "$script_dir/src/linux-platform-x11.c" \
    -lX11 \
    -o "$x11_output"

output_dir="$script_dir/prebuilds/linux-$arch"
mkdir -p "$output_dir"
install -m 755 "$wayland_output" "$output_dir/linux-platform-wayland.node"
install -m 755 "$x11_output" "$output_dir/linux-platform-x11.node"
printf 'Built %s\n' "$output_dir/linux-platform-wayland.node"
printf 'Built %s\n' "$output_dir/linux-platform-x11.node"
