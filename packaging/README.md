# Packaging

| Path | What |
|:---|:---|
| `../scripts/install.sh` | macOS daemon installer: engine binary + LaunchAgent, FDA steps, `--dry-run`, `--uninstall` |
| `../scripts/install-extension.sh` | Pi extension installer: clone-if-absent, `npm ci`, build, reload instruction |
| `../scripts/verify-fda.sh` | Socket and Full Disk Access check using a guarded Mail path |
| `homebrew/ultrasearch.rb` | Homebrew formula **template** for the client surfaces (tap not published) |
| `systemd/ultrasearch.service` | systemd **user** unit template for a Linux daemon |
| `../docs/engine-rebrand.md` | macOS install/replace/rollback of the live daemon (app bundle, signature, LaunchAgent) |
| `../docs/linux-daemon-blockers.md` | exactly why the daemon does not build on Linux yet, and the port checklist |
| `../engine/BUILD.md` | building the vendored engine, isolated instances, upstream sync |

## macOS: `scripts/install.sh`

```bash
source "$HOME/.cargo/env"
(cd engine && cargo build --release)
./scripts/install.sh --dry-run --bin "$PWD/engine/target/release/ultrasearch"
./scripts/install.sh         --bin "$PWD/engine/target/release/ultrasearch"
```

It installs `~/.local/bin/ultrasearch-daemon` and the app-bundle binary at
`/Applications/UltraSearch.app/Contents/MacOS/UltraSearch`, signs both with the
configured identity (ad-hoc by default), writes
`~/Library/LaunchAgents/com.pi.ultrasearch.plist`, and bootstraps the job. File
copies skip unchanged binaries, and a replaced app bundle is copied to
`UltraSearch.app.bak-<stamp>` first. The installer re-signs and restarts the job
on every invocation, so repeat installs can change the ad-hoc CDHash. `--uninstall` moves the job,
binaries and bundle to `.uninstalled-<stamp>` (reversible) and never touches
`~/Library/Application Support/UltraSearch`.

The script prints the FDA steps and the next step (`ultrasearch init --list`,
the phase-1 harness registration). Do not reinstall the daemon while another
measurement window is open (wave-2 advisor directive); record pid/entries/
event_id in every artifact.

An ad-hoc re-sign can change the CDHash and silently invalidate a Full Disk
Access grant even with the same bundle identifier. Re-enable UltraSearch in
System Settings → Privacy & Security → Full Disk Access after a failed check,
restart the LaunchAgent, and run `scripts/verify-fda.sh`. Optionally configure
a self-signed Code Signing identity in Keychain Access and pass its name through
`ULTRASEARCH_CODESIGN_IDENTITY` to `scripts/install.sh`; the default remains
ad-hoc.

The older `ultrasearch install` CLI command remains for installing the CLI/TUI
shims into `~/.local/bin`; it is not a substitute for this script (it does not
install or sign the engine binary from a chosen source).

## Homebrew (template, not published)

`homebrew/ultrasearch.rb` installs the client surfaces from the release tarball
(`ultrasearch`, `ultrasearch-tui`, `ultrasearch-mcp`); it deliberately does not
install the daemon, because a formula cannot express the Full Disk Access grant
or the bundle identity the grant is stored against. The tap is **not
published** — the header comment documents the checksum-fill and local
`brew install --build-from-source` path. Do not advertise a tap URL until it
exists.

## Linux (template, not yet runnable)

The client half works on Linux today (`$XDG_RUNTIME_DIR/ultrasearch.sock`, else
`~/.local/share/ultrasearch/ultrasearch.sock`), and CI runs typecheck, unit
tests, the package smoke test and the hermetic gate on `ubuntu-latest`. The
daemon itself is macOS-only until the checklist in
`docs/linux-daemon-blockers.md` is done. The unit file is committed so the
packaging shape is reviewed now, not on port day.

## macOS

`docs/engine-rebrand.md` is the authority: build, install both binaries, sign
with the configured identity, restart the LaunchAgent, and keep the backups for
rollback. The install paths are
`~/.local/bin/ultrasearch-daemon` and
`/Applications/UltraSearch.app/Contents/MacOS/UltraSearch`.

Do not reinstall the daemon while another measurement window is open
(wave-2 advisor directive); record pid/entries/event_id in every artifact.
