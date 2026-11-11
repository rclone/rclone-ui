This command updates Rclone UI, and the rclone it brings with it: in this
build rclone is part of Rclone UI, so `rclone update` through the `rclone`
link on your PATH updates the whole app, and `selfupdate` only says so.

If used without flags (or with the implied `--stable` flag), this command
installs the latest stable release. Use `--beta` for the latest beta, or
the stable release when that is newer. You can check in advance what would
be installed by adding the `--check` flag; `--check` alone prints your
version and the latest stable and beta releases, as `version --check` does.

The `--version VER` flag installs that Rclone UI release instead of the
latest one, older ones included. Upon a successful update the command
prints the version you updated from, should you want to go back to it.

When Rclone UI is running, the command hands the update to it and exits:
the app stops what it runs (transfers, mounts, serves), installs the
update and restarts, asking first when something would be interrupted.
If Rclone UI has only just started, it may miss the request: run the
command again. Otherwise the command installs the update itself, the way
this copy was installed:

- macOS: the Rclone UI app bundle is replaced.
- Windows: the Rclone UI installer runs, and finishes after this command
  exits.
- Linux: the AppImage is replaced; a deb or rpm install is updated through
  `sudo`.

`--package deb` or `--package rpm` installs that package on Linux instead.
With `--output PATH` the release is downloaded to `PATH`, and nothing is
installed.

Rclone UI installed from Flathub is updated by the software manager, and
this command says so.

A portable copy of Rclone UI on Windows (from the portable zip, with a
`data` folder next to `rcui.exe`) doesn't update itself either: this
command prints the release's download page, and `--check` marks your
version with "(portable)". To update the copy, download the new release's
portable zip, and replace `rcui.exe` and the `bin` folder with the ones in
it. The `data` folder and `rclone.conf` stay as they are.
