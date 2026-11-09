#!/usr/bin/env bash
# Puts cargo and the MSVC build tools on PATH for shells that start without them,
# such as the one Git opens for a hook. Sourced, so it only sets variables.

if [ -n "${USERPROFILE:-}" ] && [ -d "$USERPROFILE/.cargo/bin" ]; then
    PATH="$(cygpath -u "$USERPROFILE/.cargo/bin"):$PATH"
fi

if ! command -v cl.exe >/dev/null 2>&1; then
    vcvars_path=""
    for vs_root in "/c/Program Files/Microsoft Visual Studio" "/c/Program Files (x86)/Microsoft Visual Studio"; do
        for vs_candidate in "$vs_root"/*/*/VC/Auxiliary/Build/vcvars64.bat; do
            if [ -f "$vs_candidate" ]; then
                vcvars_path="$vs_candidate"
            fi
        done
    done
    if [ -n "$vcvars_path" ]; then
        vc_helper="$(mktemp --suffix=.cmd)"
        printf '@call "%s" >nul 2>&1\r\n@set\r\n' "$(cygpath -w "$vcvars_path")" >"$vc_helper"
        vc_env="$(cmd //c "$(cygpath -w "$vc_helper")" | tr -d '\r')"
        rm -f "$vc_helper"
        vc_value() {
            printf '%s\n' "$vc_env" | sed -n "s/^$1=//p" | head -n 1
        }
        LIB="$(vc_value LIB)"
        INCLUDE="$(vc_value INCLUDE)"
        LIBPATH="$(vc_value LIBPATH)"
        export LIB INCLUDE LIBPATH
        PATH="$(cygpath -u "$(vc_value VCToolsInstallDir)bin/Hostx64/x64"):$PATH"
        unset -f vc_value
        unset vc_env vc_helper
    fi
    unset vcvars_path vs_root vs_candidate
fi

export PATH
