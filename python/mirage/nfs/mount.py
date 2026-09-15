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
import logging
import os
import sys
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any

from mirage.nfs.backend import prepare_nfs_mount
from mirage.nfs.config import NFSConfig
from mirage.nfs.delegate import MirageNFS
from mirage.nfs.session import NFSDelegate, scoped
from mirage.ops import Ops
from mirage.workspace.session.session import Session

logger = logging.getLogger(__name__)

MOUNT_TIMEOUT_SECONDS = 10.0
UMOUNT_TIMEOUT_SECONDS = 15.0
UMOUNT_RETRY_PAUSE = 0.5
PROBE_TIMEOUT_SECONDS = 2.0
_POLL_SECONDS = 0.05


def load_wheel() -> Any:
    """Import the mirage-nfs extension, naming the install when absent.

    The wheel is optional the way FUSE's driver is: importing mirage
    never requires it, and the error names the install command rather
    than leaking an ImportError from deep inside a mount call. It is
    named directly rather than as a ``mirage-ai[nfs]`` extra, the way
    the TypeScript twin names its addon package: an extra is resolved
    at lock time, so declaring one for a wheel that is not on PyPI yet
    fails every ``uv sync`` in the repo rather than only an nfs mount.
    """
    try:
        import mirage_nfs
    except ImportError as exc:
        raise RuntimeError(
            "the nfs mount backend needs the mirage-nfs extension; "
            "install it with: pip install mirage-nfs, or build it in "
            "place with: pip install ./python/mirage-nfs") from exc
    return mirage_nfs


def mount_options(port: int,
                  config: NFSConfig,
                  platform: str | None = None) -> str:
    """The ``-o`` string for one export.

    ``port=mountport=<port>`` keeps portmap (111) and NLM out of the
    picture entirely; ``actimeo=0`` keeps client attribute caches
    fresh, the analogue of the FUSE mounts' ``attr_timeout=0``.

    The rest is the escape hatch, and it is the difference between a
    stalled server costing an error and costing the host. A hard mount
    -- the platform default -- blocks every I/O on the mountpoint
    forever and uninterruptibly when nothing answers, and since macOS
    walks the mount table for Finder, df and Spotlight, one wedged
    mount takes the desktop with it. ``soft`` + ``timeo`` + ``retrans``
    bound the wait and fail the call instead; ``intr`` makes even a
    hard mount killable; ``deadtimeout`` lets the kernel forcibly
    unmount a mount nothing has answered for, which is the only
    cleanup left when the serving process died without unmounting.

    ``intr`` is darwin-only because Linux has ignored it since 2.6.25,
    where ``soft`` is the whole answer.

    Args:
        port (int): the TCP port serving both MOUNT and NFS.
        config (NFSConfig): the resilience knobs.
        platform (str | None): platform tag, defaulting to the running
            one; a parameter so the string is testable everywhere.

    Returns:
        str: comma-separated mount options.
    """
    tag = sys.platform if platform is None else platform
    darwin = tag == "darwin"
    parts = [
        "nolocks" if darwin else "nolock",
        "vers=3",
        "tcp",
        "rsize=131072",
        "actimeo=0",
        f"port={port}",
        f"mountport={port}",
        f"timeo={config.timeo}",
        f"retrans={config.retrans}",
    ]
    if config.soft:
        parts.append("soft")
    if darwin:
        parts.append("intr")
        if config.dead_timeout > 0:
            parts.append(f"deadtimeout={config.dead_timeout}")
    return ",".join(parts)


def mount_args(mountpoint: str,
               port: int,
               export: str,
               config: NFSConfig | None = None,
               platform: str | None = None) -> list[str]:
    """The kernel mount command for one export.

    Args:
        mountpoint (str): where to mount.
        port (int): the TCP port serving both MOUNT and NFS.
        export (str): export path, ``/`` or ``/<prefix>``.
        config (NFSConfig | None): resilience knobs; None takes the
            defaults, which is what every caller outside a test wants.
        platform (str | None): platform tag, defaulting to the running
            one; a parameter so the argv is testable everywhere.

    Returns:
        list[str]: argv for the platform's mount command.
    """
    tag = sys.platform if platform is None else platform
    knobs = config or NFSConfig()
    # The host the server was bound to, not a hardcoded loopback: a
    # config naming another address (127.0.0.2, a second loopback alias)
    # binds there and would otherwise be mounted from an address nothing
    # is listening on.
    source = f"{knobs.host}:{export}"
    opts = mount_options(port, knobs, tag)
    if tag == "darwin":
        return ["mount_nfs", "-o", opts, source, mountpoint]
    return ["mount", "-t", "nfs", "-o", opts, source, mountpoint]


def umount_args(mountpoint: str,
                force: bool = False,
                platform: str | None = None) -> list[str]:
    """The unmount command for a mountpoint.

    ``umount -f`` is the NFS force path on both platforms, and it is
    the one that answers when the server behind the mount is already
    gone: a plain unmount asks the filesystem to flush first, which is
    a request nothing is left to serve.

    Args:
        mountpoint (str): the mounted path.
        force (bool): whether to force the unmount.
        platform (str | None): platform tag, for tests.
    """
    del platform
    return ["umount", "-f", mountpoint] if force else ["umount", mountpoint]


def last_resort_args(mountpoint: str,
                     platform: str | None = None) -> list[str]:
    """The unmount of last resort, which differs by platform.

    Linux has ``umount -l``: a lazy detach is a namespace operation, so
    it succeeds without asking the filesystem anything and takes the
    mountpoint out of every path lookup immediately, with the old mount
    surviving only for handles already open. macOS has no lazy unmount
    at all -- its ``umount`` takes only ``-fv`` -- so the last rung
    there is ``diskutil``, which asks the volume layer instead.

    Args:
        mountpoint (str): the mounted path.
        platform (str | None): platform tag, for tests.
    """
    tag = sys.platform if platform is None else platform
    if tag == "darwin":
        return ["diskutil", "unmount", "force", mountpoint]
    return ["umount", "-l", mountpoint]


def prepare_mountpoint(mountpoint: str | None) -> tuple[str, bool]:
    """Resolve the mountpoint, creating a temporary one when unnamed.

    Args:
        mountpoint (str | None): caller-owned path, or None for a
            fresh temp directory mirage owns and may delete.

    Returns:
        tuple[str, bool]: the path and whether mirage owns it.
    """
    if mountpoint:
        os.makedirs(mountpoint, exist_ok=True)
        return mountpoint, False
    return tempfile.mkdtemp(prefix="mirage-nfs-"), True


async def _ismount_off_loop(path: str) -> bool:
    """``os.path.ismount`` from a worker thread.

    The probe stats the mountpoint, and over NFS that stat is served by
    this very event loop -- run inline it would block the loop that has
    to answer it, which is the self-touch deadlock in miniature.

    Args:
        path (str): the mountpoint to probe.
    """
    return await asyncio.to_thread(os.path.ismount, path)


async def await_ismount(
    mountpoint: str,
    timeout: float = MOUNT_TIMEOUT_SECONDS,
    probe: Callable[[str], Awaitable[bool]] = _ismount_off_loop,
    probe_timeout: float = PROBE_TIMEOUT_SECONDS,
) -> None:
    """Wait until the kernel reports a live mount, or fail loudly.

    The FSKit lesson: a mountpoint directory existing is not a mount,
    so readiness is ``ismount``, never bare existence.

    Every probe is bounded, not just the loop around them. A probe is
    a stat, and a stat of a mount whose server never answers does not
    return -- so a deadline checked only between probes is a deadline
    that never fires, and the wait that was supposed to fail after ten
    seconds hangs instead. The cancelled probe leaves its worker
    thread blocked in the kernel for good; that is the cost of not
    hanging the loop, and it is bounded by the deadline above.

    Args:
        mountpoint (str): the path being mounted.
        timeout (float): seconds to wait before giving up.
        probe (Callable): mount check, injectable for tests.
        probe_timeout (float): seconds one probe may take.

    Raises:
        TimeoutError: the mount never came up.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            if await asyncio.wait_for(probe(mountpoint),
                                      timeout=probe_timeout):
                return
        except TimeoutError:
            # Expected while a mount is still settling, and the whole
            # point of the bound when it is not: keep polling until the
            # deadline below, which is the error the caller sees.
            logger.debug("nfs mount probe of %r timed out after %ss",
                         mountpoint, probe_timeout)
        await asyncio.sleep(_POLL_SECONDS)
    raise TimeoutError(
        f"nfs mount at {mountpoint!r} did not come up within {timeout}s")


async def run_mount(mountpoint: str,
                    port: int,
                    export: str,
                    config: NFSConfig | None = None) -> None:
    """Run the kernel mount command and wait for the mount to be live.

    Args:
        mountpoint (str): where to mount.
        port (int): the server's TCP port.
        export (str): export path for the MOUNT protocol.
        config (NFSConfig | None): resilience knobs for the mount
            options; None takes the defaults.

    Raises:
        RuntimeError: the mount command failed, with its output.
        TimeoutError: the command succeeded but no mount appeared.
    """
    argv = mount_args(mountpoint, port, export, config)
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{argv[0]} failed ({proc.returncode}): "
                           f"{out.decode(errors='replace').strip()}")
    await await_ismount(mountpoint)


BoundedRunner = Callable[[list[str], float], Awaitable["int | None"]]


async def _run_bounded(argv: list[str], timeout: float) -> int | None:
    """Run a teardown command, giving up rather than waiting forever.

    Args:
        argv (list[str]): the command to run.
        timeout (float): seconds to wait for it.

    Returns:
        int | None: the exit status, or None if it outlived the wait.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL)
    try:
        return await asyncio.wait_for(proc.wait(), timeout=timeout)
    except TimeoutError:
        # An unmount that outlived its wait is stuck in the kernel on a
        # mount nothing answers. The kill frees this coroutine, not the
        # child -- an uninterruptible wait ignores it -- so the child is
        # never awaited again, and the escalation above moves on.
        logger.debug("%s on %r outlived %ss", argv[0], argv[-1], timeout)
        proc.kill()
        return None


async def run_umount(mountpoint: str,
                     timeout: float = UMOUNT_TIMEOUT_SECONDS,
                     runner: BoundedRunner = _run_bounded,
                     retry_pause: float = UMOUNT_RETRY_PAUSE) -> None:
    """Unmount, escalating, and never blocking forever.

    Four rungs, each bounded: a plain unmount, the same one again after
    a pause, ``umount -f``, and the platform's last resort
    (``umount -l`` on linux, ``diskutil unmount force`` on darwin).
    Every one of them can block in the kernel when the mount's server
    has stopped answering, which is exactly when teardown is being
    asked to run, so the wait is what has to be bounded rather than the
    outcome trusted.

    The retry is the EBUSY rung, and it only runs when the first
    attempt *answered*: a busy target is usually a child that has not
    finished exiting, and one that answered will answer again in
    milliseconds. A first attempt that timed out is a wedged mount
    instead, where a second plain unmount would only spend the same
    wait again, so that case escalates straight to force. The runner
    reports a status, not an errno, so the rung is not conditioned on
    EBUSY itself -- checking the exit code would mean parsing umount's
    wording in whatever locale it was written for.

    Failing every rung leaves a live mount whose server is about to
    stop, which is the state that wedges a machine, so it is reported
    at warning with the command that clears it rather than passed over.

    Args:
        mountpoint (str): the mounted path.
        timeout (float): seconds each attempt may take.
        runner (BoundedRunner): runs one attempt; injectable for tests.
        retry_pause (float): seconds before the EBUSY retry.
    """
    plain = umount_args(mountpoint)
    answered = await runner(plain, timeout)
    if answered == 0:
        return
    if answered is not None:
        await asyncio.sleep(retry_pause)
        if await runner(plain, timeout) == 0:
            return
    if await runner(umount_args(mountpoint, force=True), timeout) == 0:
        return
    if await runner(last_resort_args(mountpoint), timeout) == 0:
        return
    recovery = " ".join(last_resort_args(mountpoint))
    logger.warning(
        "nfs mountpoint %r could not be unmounted; it is still live with no "
        "server behind it, which blocks anything that touches it. Clear it "
        "with: sudo %s", mountpoint, recovery)


async def start_server(
        ops: Ops,
        config: NFSConfig,
        session: Session | None = None) -> tuple[NFSDelegate, Any]:
    """Run the mount guards and start the NFS server for one op tree.

    One server serves one delegate, so the session is fixed here rather
    than per mount: a second session needs a second server, which is
    what ``KernelMounts`` gives it.

    Args:
        ops (Ops): the op facade to serve.
        config (NFSConfig): host, port and flush knobs.
        session (Session | None): bind every call to this session's
            mount grants, exactly as a shell command in it would run.

    Returns:
        tuple[NFSDelegate, Any]: the delegate and the server handle,
        whose ``port()`` reports the bound port.
    """
    prepare_nfs_mount("nfs", ops, config)
    wheel = load_wheel()
    fs = MirageNFS(ops, config)
    delegate = scoped(fs, session)
    uid = os.getuid() if hasattr(os, "getuid") else 0
    gid = os.getgid() if hasattr(os, "getgid") else 0
    handle = wheel.start(delegate,
                         asyncio.get_running_loop(), config.host, config.port,
                         fs.root_dir(), uid, gid, config.idle_flush_seconds)
    # The manager holds the scoped delegate too: its teardown flush
    # writes bytes this session's ops accepted, so it runs under the
    # same grants that accepted them.
    return delegate, handle
