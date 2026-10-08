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

import importlib
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import Any

from mirage.fuse.backend import MountBackend, prepare_backend
from mirage.fuse.darwin import install_macfuse_extensions
from mirage.fuse.fs import MirageFS
from mirage.types import JsonValue
from mirage.workspace.files import Files
from mirage.workspace.session.session import SessionState


def resolve_fusermount_binary() -> str | None:
    """Locate the platform FUSE unmount helper.

    The fuse3 package ships only ``fusermount3`` on Fedora, RHEL, Amazon
    Linux 2023, openSUSE and Alpine. Debian and Ubuntu add a ``fusermount``
    symlink, so CI on Ubuntu never exercises the fallback.

    Returns:
        str | None: the path to ``fusermount``, else to ``fusermount3``, or
            None when neither is on PATH.
    """
    return shutil.which("fusermount") or shutil.which("fusermount3")


def canonical_mountpoint(mountpoint: str) -> str:
    """The path the kernel's mount table records for ``mountpoint``.

    Resolve it at mount time: a parent or symlink removed later no longer
    resolves to where the mount sits.

    Args:
        mountpoint (str): the path as the caller gave it.

    Returns:
        str: the absolute path with its parent fully resolved.
    """
    path = os.path.abspath(mountpoint)
    return os.path.join(
        os.path.realpath(os.path.dirname(path)), os.path.basename(path)
    )


def is_mounted(mountpoint: str) -> bool:
    """Whether the kernel's mount table lists ``mountpoint``.

    Reads /proc/self/mounts rather than stat'ing the path, which would call
    into the very FUSE server being released. The path is compared as
    given: pass the one canonical_mountpoint returned at mount time.

    Args:
        mountpoint (str): the canonical path to look up.

    Returns:
        bool: True while a mount sits at ``mountpoint``.
    """
    target = os.fsencode(mountpoint)
    with open("/proc/self/mounts", "rb") as fh:
        return any(
            line.split(b" ")[1].decode("unicode_escape").encode("latin-1")
            == target
            for line in fh
        )


def unmount_with_fusermount(mountpoint: str) -> None:
    """Release a Linux FUSE mount with fusermount or fusermount3.

    The unmount is lazy (``-z``), so a busy mount detaches at once. A mount
    already released from outside needs no helper and counts as unmounted.

    Args:
        mountpoint (str): the mounted path, as canonical_mountpoint
            returned it at mount time.

    Raises:
        FileNotFoundError: neither helper is on PATH and the path is still
            mounted.
        OSError: the helper failed and the path is still mounted.
    """
    binary = resolve_fusermount_binary()
    if binary is None:
        if is_mounted(mountpoint):
            raise FileNotFoundError(
                f"cannot unmount {mountpoint}: neither 'fusermount' nor "
                "'fusermount3' is on PATH"
            )
        return
    proc = subprocess.run([binary, "-uz", mountpoint], capture_output=True)
    if proc.returncode != 0 and is_mounted(mountpoint):
        raise OSError(
            f"cannot unmount {mountpoint}: "
            f"{proc.stderr.decode(errors='replace').strip()}"
        )


def load_fuse() -> Any:
    # mfusepy resolves libfuse while it is imported, and reports each way
    # that can fail with a different type: ImportError when the extra is
    # missing, OSError when no driver is found, AttributeError when the
    # library found has the wrong major version.
    try:
        fuse = importlib.import_module("mfusepy")
    except (ImportError, OSError, AttributeError) as err:
        raise RuntimeError(
            "FUSE support requires the 'fuse' extra: install "
            '"mirage-ai[fuse]" plus the OS driver (macFUSE, fuse3, or '
            "WinFsp). Setup and support matrix: "
            "https://mirage.dev/home/setup/fuse"
        ) from err
    install_macfuse_extensions(fuse)
    return fuse


def _prepare_mountpoint(mountpoint: str) -> None:
    # WinFsp requires a nonexistent mountpoint and creates it itself; an
    # existing directory fails with "mount point in use". POSIX libfuse is
    # the opposite (the directory must exist), so only Windows removes it.
    # rmdir keeps this safe: a non-empty directory raises instead of being
    # silently discarded.
    if sys.platform == "win32" and os.path.isdir(mountpoint):
        os.rmdir(mountpoint)


def _run_fuse(
    fuse: Any,
    fs: MirageFS,
    mountpoint: str,
    foreground: bool,
    backend: MountBackend = MountBackend.FUSE,
) -> None:
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
    opts: dict[str, JsonValue] = {"attr_timeout": 0}
    if backend is MountBackend.FSKIT:
        # The recipe verified on a real macFUSE 5.x FSKit mount (issue #82):
        # backend=fskit plus a volname, and NO direct_io. Do not "restore"
        # direct_io here on the theory that it is merely inert on this path;
        # the only reported working mount omits it, and this is not a
        # configuration we can test in CI.
        opts["backend"] = backend.value
        opts["volname"] = os.path.basename(mountpoint.rstrip("/"))
    else:
        opts["direct_io"] = True
    fuse.FUSE(
        fs,
        mountpoint,
        nothreads=True,
        foreground=foreground,
        **opts,
        **win_opts,
    )


def _await_ready(
    thread: threading.Thread, mountpoint: str, timeout: float = 10.0
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # POSIX: the pre-existing directory becomes a mountpoint. Windows:
        # _prepare_mountpoint removed the directory and WinFsp recreates it
        # when the filesystem is live, so bare existence is the ready signal
        # (os.path.ismount does not recognize WinFsp directory mounts).
        # FSKit does NOT get that shortcut: macFUSE creates the /Volumes
        # entry while mounting and leaves the empty directory behind when
        # the handoff fails, so existence there says nothing about liveness.
        # The macOS integ job caught exactly that, reporting a failed mount
        # as a confusing ENOENT on the first read.
        if os.path.ismount(mountpoint):
            return
        if sys.platform == "win32" and os.path.lexists(mountpoint):
            return
        if not thread.is_alive():
            raise RuntimeError(
                f"FUSE mount thread for {mountpoint!r} exited before the "
                "mountpoint became live"
            )
        time.sleep(0.02)
    raise TimeoutError(
        f"FUSE mount at {mountpoint!r} did not become ready within "
        f"{timeout:g}s"
    )


def mount_background(
    ops: Files,
    mountpoint: str,
    root_prefix: str = "",
    session: SessionState | None = None,
    backend: str | MountBackend = MountBackend.FUSE,
) -> threading.Thread:
    """Mount in a background thread and return once the tree is live.

    Args:
        ops (Files): the op facade to serve.
        mountpoint (str): where to mount.
        root_prefix (str): mount root; non-empty scopes the tree.
        session (SessionState | None): bind ops to this session's mount grants.
        backend (str | MountBackend): kernel interface to use.

    Returns:
        threading.Thread: the thread serving the mount.
    """
    resolved = prepare_backend(
        backend, ops=ops, mountpoint=mountpoint, root_prefix=root_prefix
    )
    fuse = load_fuse()
    fs = MirageFS(ops, root_prefix=root_prefix, session=session)
    _prepare_mountpoint(mountpoint)
    t = threading.Thread(
        target=_run_fuse,
        args=(fuse, fs, mountpoint, True, resolved),
        daemon=True,
    )
    t.start()
    _await_ready(t, mountpoint)
    return t


def mount(
    ops: Files | None = None,
    mountpoint: str = "",
    foreground: bool = True,
    fs: MirageFS | None = None,
    daemon: bool = False,
    post_fork=None,
    backend: str | MountBackend = MountBackend.FUSE,
) -> None:
    resolved = prepare_backend(backend, ops=ops, mountpoint=mountpoint)
    if fs is None:
        if ops is None:
            raise ValueError("mount requires either ops or a prebuilt fs")
        fs = MirageFS(ops)
    fuse = load_fuse()
    _prepare_mountpoint(mountpoint)
    if daemon:
        pid = os.fork()
        if pid > 0:
            os._exit(0)
        os.setsid()
        if post_fork:
            post_fork()
        _run_fuse(fuse, fs, mountpoint, True, resolved)
        return
    t = threading.Thread(
        target=_run_fuse,
        args=(fuse, fs, mountpoint, foreground, resolved),
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
            binary = resolve_fusermount_binary()
            if binary is not None:
                subprocess.run([binary, "-u", mountpoint], capture_output=True)
        t.join(timeout=5)
