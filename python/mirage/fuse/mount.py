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

import os
import subprocess
import sys
import threading
import time

try:
    import mfusepy as fuse
except ImportError:
    fuse = None

from mirage.fuse.fs import MirageFS
from mirage.ops import Ops


def _prepare_mountpoint(mountpoint: str) -> None:
    # WinFsp requires a nonexistent mountpoint and creates it itself; an
    # existing directory fails with "mount point in use". POSIX libfuse is
    # the opposite (the directory must exist), so only Windows removes it.
    # rmdir keeps this safe: a non-empty directory raises instead of being
    # silently discarded.
    if sys.platform == "win32" and os.path.isdir(mountpoint):
        os.rmdir(mountpoint)


def _run_fuse(fs: MirageFS, mountpoint: str, foreground: bool) -> None:
    # direct_io: the kernel ignores st_size and keeps issuing reads until the
    # backend returns EOF, which is what makes size-unknown (API-backed) files
    # readable by tools that never fstat (cat, grep).
    # attr_timeout=0: the kernel re-stats through fgetattr after open instead
    # of trusting the cached pre-open size; without it fstat-based tools see
    # a stale 0 (wc -c prints 0, BSD cp copies 0 bytes, tail -c dumps the
    # whole file). mfusepy forwards unknown kwargs as -o mount options.
    # uid=-1/gid=-1 (win32): the WinFsp-FUSE builtin that presents all files
    # as owned by the mounting user; POSIX uid/gid values reported by getattr
    # have no meaningful SID mapping on Windows (see the WinFsp FAQ).
    win_opts = {"uid": -1, "gid": -1} if sys.platform == "win32" else {}
    fuse.FUSE(fs,
              mountpoint,
              nothreads=True,
              foreground=foreground,
              direct_io=True,
              attr_timeout=0,
              **win_opts)


def _await_ready(thread: threading.Thread,
                 mountpoint: str,
                 timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # POSIX: the pre-existing directory becomes a mountpoint. Windows:
        # _prepare_mountpoint removed the directory and WinFsp recreates it
        # when the filesystem is live, so bare existence is the ready signal
        # (os.path.ismount does not recognize WinFsp directory mounts).
        if os.path.ismount(mountpoint) or (sys.platform == "win32"
                                           and os.path.lexists(mountpoint)):
            return
        if not thread.is_alive():
            raise RuntimeError(
                f"FUSE mount thread for {mountpoint!r} exited before the "
                "mountpoint became live")
        time.sleep(0.02)
    raise TimeoutError(
        f"FUSE mount at {mountpoint!r} did not become ready within "
        f"{timeout:g}s")


def mount_background(ops: Ops,
                     mountpoint: str,
                     agent_id: str | None = None,
                     root_prefix: str = "") -> threading.Thread:
    fs = MirageFS(ops, agent_id=agent_id, root_prefix=root_prefix)
    _prepare_mountpoint(mountpoint)
    t = threading.Thread(target=_run_fuse,
                         args=(fs, mountpoint, True),
                         daemon=True)
    t.start()
    _await_ready(t, mountpoint)
    return t


def mount(ops: Ops | None = None,
          mountpoint: str = "",
          foreground: bool = True,
          agent_id: str | None = None,
          fs: MirageFS | None = None,
          daemon: bool = False,
          post_fork=None) -> None:
    if fs is None:
        fs = MirageFS(ops, agent_id=agent_id)
    _prepare_mountpoint(mountpoint)
    if daemon:
        pid = os.fork()
        if pid > 0:
            os._exit(0)
        os.setsid()
        if post_fork:
            post_fork()
        _run_fuse(fs, mountpoint, foreground=True)
        return
    t = threading.Thread(
        target=_run_fuse,
        args=(fs, mountpoint, foreground),
        daemon=True,
    )
    if post_fork:
        post_fork()
    t.start()
    try:
        while t.is_alive():
            t.join(timeout=0.5)
    except KeyboardInterrupt:
        print("\nUnmounting...", flush=True)
        if sys.platform == "darwin":
            subprocess.run(
                ["diskutil", "unmount", "force", mountpoint],
                capture_output=True,
            )
        elif sys.platform == "win32":
            # No fusermount equivalent: WinFsp tears the mount down when the
            # serving process exits.
            pass
        else:
            subprocess.run(["fusermount", "-u", mountpoint],
                           capture_output=True)
        t.join(timeout=5)
