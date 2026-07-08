# Source this before `tauri android build/dev`:  . scripts/android-env.sh
#
# NDK r23+ removed the GNU-named binutils wrappers (aarch64-linux-android-ranlib
# etc.). cargo-mobile2 exports CC/AR for cross builds, but openssl-src's
# Makefile also invokes RANLIB — without these exports the vendored-OpenSSL
# build dies with "aarch64-linux-android-ranlib: command not found".
#
# Requires ANDROID_HOME (and optionally NDK_HOME; falls back to the newest
# installed NDK).

if [ -z "$ANDROID_HOME" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
if [ -z "$NDK_HOME" ]; then
  NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
  export NDK_HOME
fi

_novalis_prebuilt="$(ls -d "$NDK_HOME"/toolchains/llvm/prebuilt/* 2>/dev/null | head -1)"
_novalis_tc="$_novalis_prebuilt/bin"

export RANLIB_aarch64_linux_android="$_novalis_tc/llvm-ranlib"
export RANLIB_armv7_linux_androideabi="$_novalis_tc/llvm-ranlib"
export RANLIB_i686_linux_android="$_novalis_tc/llvm-ranlib"
export RANLIB_x86_64_linux_android="$_novalis_tc/llvm-ranlib"

unset _novalis_prebuilt _novalis_tc
