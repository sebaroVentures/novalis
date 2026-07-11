# Reproducible Linux build environment for the Tauri desktop bundle
# (.deb + .AppImage). Used by scripts/build-linux-container.sh locally and by
# the self-hosted-runner release job — so a macOS runner (or any host with
# Docker) can produce Linux artifacts without a Linux machine.
#
# Native to the host arch: on an arm64 host this builds arm64 Linux; run with
# `--platform linux/amd64` (qemu) for x86_64. See MOBILE.md-style notes in the
# script.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Tauri v2 Linux system dependencies (webkit2gtk 4.1 stack) + bundling tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates git \
      libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
      libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
      patchelf desktop-file-utils xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (matches CI) + pnpm 11.0.9 (package.json packageManager; pnpm 11
# needs Node 22+ — it fails on 20 with ERR_UNKNOWN_BUILTIN_MODULE).
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g pnpm@11.0.9 \
    && rm -rf /var/lib/apt/lists/*

# Rust via rustup; the pinned 1.93.0 (rust-toolchain.toml) is pre-installed so
# cold builds don't pay the toolchain download.
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --default-toolchain 1.93.0 --profile minimal

WORKDIR /build
