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


def _run_fuse(fs: MirageFS, mountpoint: str, foreground: bool) -> None:
    # direct_io: the kernel ignores st_size and keeps issuing reads until the
    # backend returns EOF, which is what makes size-unknown (API-backed) files
    # readable by tools that never fstat (cat, grep).
    # attr_timeout=0: the kernel re-stats through fgetattr after open instead
    # of trusting the cached pre-open size; without it fstat-based tools see
    # a stale 0 (wc -c prints 0, BSD cp copies 0 bytes, tail -c dumps the
    # whole file). mfusepy forwards unknown kwargs as -o mount options.
    fuse.FUSE(fs,
              mountpoint,
              nothreads=True,
              foreground=foreground,
              direct_io=True,
              attr_timeout=0)


def _await_ready(thread: threading.Thread,
                 mountpoint: str,
                 timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if os.path.ismount(mountpoint):
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
        else:
            subprocess.run(["fusermount", "-u", mountpoint],
                           capture_output=True)
        t.join(timeout=5)
