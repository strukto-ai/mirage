# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import json
import os
import signal
import subprocess
import sys
import tempfile

from mirage.fuse.mount import mount_background
from mirage.nfs.config import NFSConfig
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.nfs import NFSManager

# The same tree mounted both ways, driven by the same lines, diffed. The
# adapter-level twin of this lives in tests/nfs/test_fuse_parity.py and
# runs everywhere; this one costs a kernel and answers the question that
# one cannot: whether the two adapters still agree once a real client is
# the thing asking.
#
# `{mnt}` is the mountpoint. Every line cds into it first, so nothing in
# the output carries the path and the two sides are comparable verbatim.
COMMANDS: tuple[tuple[str, str], ...] = (
    ("cat", "cd {mnt} && cat a.txt"),
    ("ls", "cd {mnt} && ls | sort"),
    ("wc_bytes", "cd {mnt} && wc -c < a.txt"),
    ("head_bytes", "cd {mnt} && head -c 3 a.txt"),
    ("md5", "cd {mnt} && md5sum big.bin | cut -d' ' -f1"),
    ("stat_size", "cd {mnt} && stat -c %s a.txt"),
    ("nested_cat", "cd {mnt} && cat docs/b.txt"),
    ("find_files", "cd {mnt} && find . -type f | sort"),
    ("find_dirs", "cd {mnt} && find . -type d | sort"),
    ("grep", "cd {mnt} && grep -c . a.txt"),
    ("readlink", "cd {mnt} && readlink lnk"),
    ("cat_through_link", "cd {mnt} && cat lnk"),
    ("stat_link_type", "cd {mnt} && stat -c %F lnk"),
    ("missing_file", "cd {mnt} && cat nope.txt 2>&1 | sed 's/.*: //'"),
    ("dir_as_file", "cd {mnt} && cat docs 2>&1 | sed 's/.*: //'"),
)

# A write per side, so neither sees the other's file: the two mounts are
# two views of one tree, and comparing a shared name would compare the
# first side's write with the second side's read of it.
WRITE = "cd {mnt} && echo written-{side} > w-{side}.txt && cat w-{side}.txt"

MOUNTPOINTS: list[str] = []


def force_unmount_all() -> None:
    """Drop both kernel mounts, whatever state they are in."""
    for point in MOUNTPOINTS:
        for argv in (["fusermount", "-u",
                      point], ["umount", "-f", point], ["umount", "-l",
                                                        point]):
            try:
                done = subprocess.run(argv,
                                      capture_output=True,
                                      timeout=15,
                                      check=False)
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue
            if done.returncode == 0:
                break
    MOUNTPOINTS.clear()


def _on_signal(signum: int, _frame: object) -> None:
    force_unmount_all()
    os._exit(128 + signum)


async def sh(line: str) -> tuple[int, str]:
    """Run one shell line off-loop and capture its output.

    The nfs server is served by this event loop, so every touch of its
    mountpoint has to leave the process; the fuse mount is served by a
    thread and would not care, but the two sides must run identically
    or the comparison is between two harnesses rather than two mounts.

    Args:
        line (str): the shell line to run.

    Returns:
        tuple[int, str]: exit status and combined output.
    """
    proc = await asyncio.create_subprocess_exec(
        "sh",
        "-c",
        line,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except TimeoutError:
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def main() -> None:
    result: dict[str, object] = {}
    # Seeded on the resource rather than through the shell, the way the
    # fuse battery seeds: the bytes are then exactly what both mounts
    # serve, with no command in the middle to disagree about.
    store = RAMResource()
    store._store.dirs.add("/")
    store._store.dirs.add("/docs")
    store._store.files["/a.txt"] = b"alpha\n"
    store._store.files["/docs/b.txt"] = b"beta\n"
    store._store.files["/big.bin"] = bytes(range(256)) * 16
    ws = Workspace({"/": store}, mode=MountMode.WRITE)
    await ws.execute("ln -s a.txt /lnk")

    fuse_point = tempfile.mkdtemp(prefix="mirage-diff-fuse-")
    manager = NFSManager()
    mismatches: list[dict[str, object]] = []
    nfs_point = ""
    try:
        # FUSE first: its mount runs on a thread of its own, so bringing
        # it up cannot be answered by the loop the nfs server needs.
        mount_background(ws.ops, fuse_point)
        MOUNTPOINTS.append(fuse_point)
        nfs_point = await manager.setup(ws.ops, "/", None, NFSConfig(port=0))
        MOUNTPOINTS.append(nfs_point)
        result["both_mounted"] = True

        for name, template in COMMANDS:
            fuse = await sh(template.format(mnt=fuse_point))
            nfs = await sh(template.format(mnt=nfs_point))
            if fuse != nfs:
                mismatches.append({
                    "case": name,
                    "fuse": list(fuse),
                    "nfs": list(nfs)
                })

        fuse_write = await sh(WRITE.format(mnt=fuse_point, side="fuse"))
        nfs_write = await sh(WRITE.format(mnt=nfs_point, side="nfs"))
        if (fuse_write[0],
                fuse_write[1].replace("fuse",
                                      "")) != (nfs_write[0],
                                               nfs_write[1].replace("nfs",
                                                                    "")):
            mismatches.append({
                "case": "write_readback",
                "fuse": list(fuse_write),
                "nfs": list(nfs_write)
            })

        result["compared"] = len(COMMANDS) + 1
        result["mismatches"] = mismatches
        result["all_match"] = not mismatches
    finally:
        await manager.close()
        if nfs_point in MOUNTPOINTS:
            MOUNTPOINTS.remove(nfs_point)
        # Whatever is left is the fuse mount, and the rungs tolerate a
        # missing fusermount so a host without it fails on the mount it
        # could not make rather than on the teardown of one it never did.
        force_unmount_all()
    print(json.dumps(result))


if __name__ == "__main__":
    if sys.platform == "win32":
        raise SystemExit("the differential needs a fuse mount and an nfs one")
    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    asyncio.run(main())
