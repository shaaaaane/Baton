#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
python3 - "$root" "$test_dir" <<'PY'
import pathlib, shutil, sys
root, target = map(pathlib.Path, sys.argv[1:])
(target / "src").mkdir()
(target / "Cargo.toml").write_text('''[package]
name = "macos-drop-portable"
version = "0.1.0"
edition = "2021"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.13", default-features = false, features = ["blocking"] }
''')
source = (root / "src-tauri/src/macos_drop.rs").read_text()
# Compile the exact command bodies/event handlers, replacing only Tauri's host
# boundary and proc-macro registration. TLS is disabled in this offline harness;
# this does not compile AppKit/WKWebView or validate macOS TLS.
source = source.replace("#[tauri::command]\n", "")
source = "use crate::tauri;\n" + source
(target / "src/drop.rs").write_text(source + '\ninclude!("cases.rs");\n')
shutil.copyfile(root / "test/native/macos-drop-shim.rs", target / "src/lib.rs")
shutil.copyfile(root / "test/native/macos-drop-cases.rs", target / "src/cases.rs")
shutil.copyfile(root / "src-tauri/Cargo.lock", target / "Cargo.lock")
PY
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/baton-macos-drop-portable-target}"
cargo test --manifest-path "$test_dir/Cargo.toml" "$@"
