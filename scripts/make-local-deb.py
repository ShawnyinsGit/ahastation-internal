#!/usr/bin/env python3
"""Assemble a Debian .deb for AhaStation (linux arm64) without fpm/GNU ar.

Why: fpm shells out to BSD `ar` on macOS, which emits a 96-byte stub archive
instead of a real deb. This script builds the three members directly:
  debian-binary, control.tar.gz, data.tar.gz  -> GNU ar archive.

Source tree: release/linux-arm64-unpacked (produced by electron-builder).
Output:      release/ahastation_0.17.0_arm64.deb
"""

import gzip
import io
import os
import tarfile
import time

ROOT = "/Users/heartline/Documents/Claude/AhaStation"
UNPACKED = os.path.join(ROOT, "release", "linux-arm64-unpacked")
ICON = os.path.join(ROOT, "build", "icon.png")
OUT = os.path.join(ROOT, "release", "ahastation_0.17.0_arm64.deb")

PKG = "ahastation"
VERSION = "0.17.0"
APP_DIR = "opt/AhaStation"  # tar-member paths are relative (no leading /)
EXE = "ahastation"

DESKTOP = b"""[Desktop Entry]
Name=AhaStation
Comment=Voice-meeting AI coding collaboration
Exec=/opt/AhaStation/ahastation %U
Terminal=false
Type=Application
Icon=ahastation
Categories=Development;
StartupWMClass=AhaStation
"""

POSTINST = b"""#!/bin/sh
set -e
chown root:root /opt/AhaStation/chrome-sandbox || true
chmod 4755 /opt/AhaStation/chrome-sandbox || true
update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
"""

CONTROL_TMPL = """Package: ahastation
Version: {version}
Architecture: arm64
Maintainer: AhaStation <contact@ahastation.com>
Installed-Size: {installed_kb}
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0, libasound2, libgbm1, libdrm2
Section: devel
Priority: optional
Homepage: https://github.com/ShawnyinsGit/AhaStation
Description: AhaStation - voice-meeting AI coding collaboration client
 Multi-CLI coding agents (Claude Code / Codex / Kimi / OpenCode / Qoder)
 join your video meeting as digital-employee participants.
"""


def add_bytes(tf, arcname, data, mode=0o644, uid=0, gid=0):
    info = tarfile.TarInfo(arcname)
    info.size = len(data)
    info.mode = mode
    info.uid = uid
    info.gid = gid
    info.uname = "root"
    info.gname = "root"
    info.mtime = int(time.time())
    tf.addfile(info, io.BytesIO(data))


def build_data_tar(gz):
    # GNU_FORMAT, not the Python ≥3.8 default PAX_FORMAT: dpkg 1.20 (Debian 11)
    # rejects PAX 'x' extended headers ("corrupted filesystem tarfile").
    with tarfile.open(fileobj=gz, mode="w", format=tarfile.GNU_FORMAT) as tf:
        # App payload -> /opt/AhaStation/
        for dirpath, dirnames, filenames in os.walk(UNPACKED):
            rel = os.path.relpath(dirpath, UNPACKED)
            for d in dirnames:
                full = os.path.join(dirpath, d)
                arc = os.path.join(APP_DIR, rel, d) if rel != "." else os.path.join(APP_DIR, d)
                info = tf.gettarinfo(full, arc)
                info.uid, info.gid, info.uname, info.gname = 0, 0, "root", "root"
                tf.addfile(info)
            for f in filenames:
                full = os.path.join(dirpath, f)
                arc = os.path.join(APP_DIR, rel, f) if rel != "." else os.path.join(APP_DIR, f)
                info = tf.gettarinfo(full, arc)
                info.uid, info.gid, info.uname, info.gname = 0, 0, "root", "root"
                if os.path.islink(full):
                    tf.addfile(info)
                else:
                    with open(full, "rb") as fh:
                        tf.addfile(info, fh)
        # /usr/bin symlink
        link = tarfile.TarInfo("usr/bin/" + EXE)
        link.type = tarfile.SYMTYPE
        link.linkname = "/opt/AhaStation/" + EXE
        link.mode = 0o777
        link.uid = link.gid = 0
        link.uname = link.gname = "root"
        tf.addfile(link)
        # desktop entry + icon
        add_bytes(tf, "usr/share/applications/%s.desktop" % PKG, DESKTOP)
        with open(ICON, "rb") as fh:
            add_bytes(tf, "usr/share/icons/hicolor/512x512/apps/%s.png" % PKG, fh.read())


def build_control_tar(installed_kb):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.GNU_FORMAT) as tf:
        add_bytes(tf, "control", CONTROL_TMPL.format(version=VERSION, installed_kb=installed_kb).encode())
        add_bytes(tf, "postinst", POSTINST, mode=0o755)
    return buf.getvalue()


def ar_member(name, data):
    # GNU ar member header, name terminated with '/'
    header = "%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (name + "/", int(time.time()), 0, 0, 0o100644, len(data))
    out = header.encode("ascii") + data
    if len(data) % 2:
        out += b"\n"
    return out


def main():
    # Installed-Size in KiB
    total = 0
    for dirpath, _, filenames in os.walk(UNPACKED):
        for f in filenames:
            full = os.path.join(dirpath, f)
            if not os.path.islink(full):
                total += os.path.getsize(full)
    installed_kb = total // 1024

    print("compressing data.tar.gz ...", flush=True)
    data_buf = io.BytesIO()
    with gzip.GzipFile(fileobj=data_buf, mode="wb", compresslevel=6, mtime=0) as gz:
        build_data_tar(gz)
    data_tar_gz = data_buf.getvalue()
    print("data.tar.gz: %.1f MB" % (len(data_tar_gz) / 1e6), flush=True)

    control_tar_gz = build_control_tar(installed_kb)

    with open(OUT, "wb") as fh:
        fh.write(b"!<arch>\n")
        fh.write(ar_member("debian-binary", b"2.0\n"))
        fh.write(ar_member("control.tar.gz", control_tar_gz))
        fh.write(ar_member("data.tar.gz", data_tar_gz))
    print("wrote %s (%.1f MB)" % (OUT, os.path.getsize(OUT) / 1e6), flush=True)


if __name__ == "__main__":
    main()
