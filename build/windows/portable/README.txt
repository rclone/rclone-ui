Rclone UI, portable
===================

This copy of Rclone UI keeps everything in this folder, so you can move it,
carry it on a USB drive, or keep several copies side by side:

  data         The app's data: its settings, history, logs and cache.
  rclone.conf  rclone's config, with your remotes. Rclone UI creates it,
               empty, the first time it starts.
  bin          rclone.exe, the rclone command. It uses the same rclone.conf.
  winfsp.msi   The WinFsp installer, which the Mount page uses to install
               WinFsp when you ask it to. Mounts need WinFsp.

The data folder is what makes this copy portable. Keep it, even when it's
empty.


Updating
--------

This copy checks for updates and tells you about them, but it doesn't
install them. To update it, download the new release's portable zip from
https://github.com/rclone/rclone-ui/releases, and replace rcui.exe,
winfsp.msi and the bin folder with the ones in it. The data folder and
rclone.conf stay as they are.


Making it a normal copy
-----------------------

Delete the data folder (or move it away). Rclone UI then keeps its data in
%LOCALAPPDATA%\org.rclone.ui, as an installed copy does. rclone still uses
an rclone.conf that is next to rcui.exe, so move that away too if you want
rclone's usual config file.


What stays on this computer
---------------------------

- rclone:// links: Rclone UI registers itself to open them for your user
  account. When a computer has several copies, the one that started last
  opens them.
- Notifications: Windows keeps a registration for Rclone UI's
  notifications. When a computer has several copies, clicking a
  notification opens the one that started last.
- Passwords that you save, in Windows' Credential Manager: the password of
  this folder's rclone.conf, saved under its path, and the mail server's
  password for email notifications, which every copy of Rclone UI on this
  computer shares.
- An empty %APPDATA%\rclone folder, which rclone makes the first time this
  copy starts, unless it is there already. rclone makes it before it finds
  this folder's rclone.conf, which doesn't exist yet at that point.
- WinFsp, when you let Rclone UI install it (see below).
- Start at login, only when you turn it on in Settings.
- The bin folder on your PATH, only when you turn on "Add rclone to PATH" in
  Settings.

Turn off the last two in Settings before you delete this folder.


WinFsp
------

Rclone UI mounts remotes as drives with WinFsp - Windows File System Proxy,
Copyright (C) Bill Zissimopoulos (https://github.com/winfsp/winfsp). When
this computer doesn't have it, the Mount page offers to install it. WinFsp
installs for the whole computer, so Windows asks for administrator rights.
It stays installed when you delete this folder: uninstall it from Windows'
Settings, under Apps, if no other program needs it.


WebView2
--------

Rclone UI draws its windows with Microsoft Edge WebView2, which Windows 11
and most of Windows 10 already have. If it's missing, Rclone UI says so and
links to Microsoft's download.
