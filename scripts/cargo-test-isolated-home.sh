#!/usr/bin/env bash
set -euo pipefail

original_home="${HOME:?HOME is required}"
cargo_home="${CARGO_HOME:-$original_home/.cargo}"
rustup_home="${RUSTUP_HOME:-$original_home/.rustup}"
test_home="$(mktemp -d "${TMPDIR:-/tmp}/agent-desktop-test-home.XXXXXX")"

cleanup() {
    rm -rf -- "$test_home"
}
trap cleanup EXIT

case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*)
        # Private-file tests refuse a temp folder that inherits extra principals,
        # so the test temp folder grants only SYSTEM, Administrators and this user.
        test_temp="$test_home/Temp"
        mkdir -p "$test_temp"
        MSYS_NO_PATHCONV=1 icacls "$(cygpath -w "$test_home")" /inheritance:r /grant:r \
            "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "$USERNAME:(OI)(CI)F" /t /q >/dev/null
        TMP="$(cygpath -w "$test_temp")"
        TEMP="$TMP"
        LOCALAPPDATA="$(cygpath -w "$test_home")"
        export TMP TEMP LOCALAPPDATA
        ;;
esac

HOME="$test_home" CARGO_HOME="$cargo_home" RUSTUP_HOME="$rustup_home" cargo "$@"
