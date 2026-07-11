#!/bin/sh
# Build the Linux desktop bundle (.deb + .AppImage) in a container, so a macOS
# host (or the self-hosted mac runner) can produce Linux artifacts without a
# Linux machine. Native to the host arch by default (arm64 host → arm64 Linux);
# pass --platform linux/amd64 for x86_64 (slower, qemu-emulated).
#
# The build runs on a CLEAN `git archive HEAD` inside the container, so the
# host's node_modules/target (macOS arm64) are never touched or reused.
#
# Usage: scripts/build-linux-container.sh [docker-platform]
#   scripts/build-linux-container.sh                    # host arch (arm64)
#   scripts/build-linux-container.sh linux/amd64        # x86_64 via qemu
set -e

here="$(cd "$(dirname "$0")/.." && pwd)"
platform="${1:-}"
platform_arg=""
[ -n "$platform" ] && platform_arg="--platform $platform"
image="novalis-linux-build"
out="$here/dist-linux"

echo "==> building image ($image)${platform:+ for $platform}"
# shellcheck disable=SC2086
docker build $platform_arg -t "$image" -f "$here/docker/linux-build.Dockerfile" "$here/docker"

mkdir -p "$out"
echo "==> building the Linux bundle (clean tree from git HEAD)"
# Mount the repo read-only to export a clean tree; mount an output dir for the
# bundle. Named volumes cache the cargo registry, the build target and the pnpm
# store across runs, so only the first build is cold (matters on the runner).
# Everything else stays container-local. CARGO_TARGET_DIR points at the cached
# volume, so the bundle lands at $CARGO_TARGET_DIR/release/bundle.
# shellcheck disable=SC2086
docker run --rm $platform_arg \
  -v "$here:/src:ro" \
  -v "$out:/out" \
  -v novalis-linux-cargo-registry:/usr/local/cargo/registry \
  -v novalis-linux-target:/cache/target \
  -v novalis-linux-pnpm:/cache/pnpm-store \
  -e CARGO_TARGET_DIR=/cache/target \
  "$image" bash -euc '
    git config --global --add safe.directory /src
    git -C /src archive HEAD | tar -x -C /build
    pnpm install --frozen-lockfile --store-dir /cache/pnpm-store
    pnpm --filter @novalis/desktop build
    bundle=/cache/target/release/bundle
    mkdir -p /out/deb /out/appimage /out/rpm
    cp -v "$bundle"/deb/*.deb /out/deb/ || echo "(no .deb produced)"
    cp -v "$bundle"/appimage/*.AppImage /out/appimage/ || echo "(no .AppImage produced)"
    cp -v "$bundle"/rpm/*.rpm /out/rpm/ || true
  '

echo "==> artifacts in $out:"
find "$out" -type f \( -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) -exec ls -lh {} \;
