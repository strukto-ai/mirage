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
import hashlib
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.nfs.backend import check_platform_nfs
from mirage.nfs.config import NFSConfig
from mirage.resource.ram import RAMResource
from mirage.types import FileStat
from mirage.workspace.nfs import NFSManager

# The battery asks the OS for a port instead of taking the fixed
# default. Two batteries run back to back in one CI job, and the second
# one hit EADDRINUSE on 20490 seventy-nine seconds after the first had
# exited with its mounts cleaned -- a race no run reproduces reliably
# and none of them should have to. The declared-mount scenario below
# still exercises the default, since a Mount(backend=nfs) carries no
# config to override it with.
EPHEMERAL = NFSConfig(port=0)

# Every mountpoint this run has created, so a crash, a Ctrl-C or a hung
# battery can still force them down. A live mount whose server has gone
# is the one state that outlives the process: every access to it blocks
# in the kernel, and on macOS that reaches anything walking the mount
# table, which is Finder and df and Spotlight rather than just this
# script.
MOUNTPOINTS: set[str] = set()

BATTERY_TIMEOUT_SECONDS = 300.0
FORCE_UMOUNT_TIMEOUT_SECONDS = 15.0


class SizelessOps:
    """Ops proxy that strips stat sizes.

    Simulates API-backed resources whose byte size is unknown until the
    content is fetched. NFSv3 has no OPEN procedure, so unlike FUSE
    there is no hydrate-on-open: the documented behavior is that such
    files stat as 0 and read as empty, with a mount-time warning.
    """

    def __init__(self, inner) -> None:
        self._inner = inner

    def __getattr__(self, name: str):
        return getattr(self._inner, name)

    async def stat(self, path: str) -> FileStat:
        result = await self._inner.stat(path)
        return result.model_copy(update={"size": None})

    def unsized_mounts(self, root_prefix: str = "") -> list[tuple[str, str]]:
        # The size-unknown declaration the mount-time warning reads:
        # a real API resource carries SIZES_ALWAYS_KNOWN=False, and
        # this proxy is standing in for one.
        del root_prefix
        return [("/", "sizeless")]


def force_unmount_all() -> None:
    """Force every recorded mountpoint down, synchronously.

    Sync on purpose: this runs from a signal handler and from the exit
    path, where the event loop may be the thing that is stuck, so it
    cannot await. ``umount -f`` is what makes that safe -- a plain
    unmount asks the filesystem to flush, and the server that would
    answer is the process being torn down.
    """
    for point in sorted(MOUNTPOINTS):
        if gone(point):
            continue
        try:
            subprocess.run(["umount", "-f", point],
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL,
                           timeout=FORCE_UMOUNT_TIMEOUT_SECONDS,
                           check=False)
        except subprocess.TimeoutExpired:
            print(
                f"integ/nfs: umount -f {point} timed out; clear it with "
                f"sudo umount -f {point}",
                file=sys.stderr)
    MOUNTPOINTS.clear()


def _on_signal(signum: int, _frame: object) -> None:
    """Force the mounts down before dying, then die.

    Args:
        signum (int): the signal received.
        _frame (object): the interrupted frame, unused.
    """
    force_unmount_all()
    os._exit(128 + signum)


async def track(manager: NFSManager,
                ops,
                prefix: str = "/",
                mountpoint: str | None = None) -> str:
    """Mount through the manager and record the mountpoint.

    Args:
        manager (NFSManager): the manager to mount with.
        ops: the op facade to serve.
        prefix (str): the virtual prefix to expose.
        mountpoint (str | None): where to mount.

    Returns:
        str: the mountpoint now serving the prefix.
    """
    point = await manager.setup(ops, prefix, mountpoint, EPHEMERAL)
    MOUNTPOINTS.add(point)
    return point


def gone(path: str) -> bool:
    """Whether a mountpoint directory is gone, without stat'ing it.

    A stat of the path would be answered by the server that has just
    stopped if the unmount had failed -- the one check that only runs
    after something went wrong would be the one that hangs. Listing the
    parent names the entry without ever crossing into it.

    Args:
        path (str): the mountpoint that should have been removed.
    """
    parent, name = os.path.split(path.rstrip("/"))
    try:
        return name not in os.listdir(parent)
    except FileNotFoundError:
        return True


async def sh(*argv: str) -> tuple[int, str]:
    """Run one command off-loop and capture its output.

    Every touch of the mountpoint must leave the event loop: the NFS
    server is served BY this loop, so a synchronous stat here would
    deadlock the request it produces.

    Args:
        argv (str): the command and its arguments.

    Returns:
        tuple[int, str]: exit code and combined output.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
    except TimeoutError:
        # A child stuck on the mountpoint holds it busy, and the unmount
        # that follows would then need its force path. Kill it first and
        # let the run fail loudly rather than quietly one step slower.
        proc.kill()
        raise
    return proc.returncode or 0, out.decode(errors="replace").strip()


async def write_file(path: str, text: str) -> int:
    code, _ = await sh("sh", "-c", f"printf '%s' '{text}' > {path}")
    return code


async def run_battery(result: dict[str, object]) -> None:
    """The single-server, multi-mount battery over a RAM workspace.

    Args:
        result (dict): probe results, keyed for truth_nfs.json.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo alpha > /a.txt")
    await ws.execute("mkdir /docs && echo beta > /docs/b.txt")

    manager = NFSManager()
    try:
        whole = await track(manager, ws.ops, "/")
        docs = await track(manager, ws.ops, "/docs")
        result["distinct_mounts"] = whole != docs

        _, out = await sh("cat", f"{whole}/a.txt")
        result["cat_a"] = out
        _, out = await sh("cat", f"{docs}/b.txt")
        result["subtree_cat_b"] = out
        _, out = await sh("ls", whole)
        result["ls_names"] = sorted(n for n in out.split() if n != "dev")

        result["write_ok"] = await write_file(f"{docs}/new.txt",
                                              "via-nfs") == 0
        _, out = await sh("cat", f"{whole}/docs/new.txt")
        result["cross_mount_readback"] = out

        code, _ = await sh("ln", "-s", "a.txt", f"{whole}/lnk")
        result["symlink_ok"] = code == 0
        _, out = await sh("readlink", f"{whole}/lnk")
        result["readlink"] = out
        _, out = await sh("cat", f"{whole}/lnk")
        result["cat_through_link"] = out
        await sh("rm", f"{whole}/lnk")
        _, out = await sh("cat", f"{whole}/a.txt")
        result["target_survives_link_rm"] = out

        code, _ = await sh(
            "sh", "-c", f"mkdir {whole}/d && "
            f"mv {whole}/docs/new.txt {whole}/d/m.txt")
        result["mkdir_mv_ok"] = code == 0

        # The wire carries an nfstime3, and an adapter that fills none
        # leaves every file dated 1970 -- which reads as a broken mount
        # to rsync, make, and any incremental copy. BSD stat spells it
        # -f %m and GNU -c %Y.
        #
        # Compared against this process's own clock rather than against
        # a floor: the file was seeded seconds ago, so its mtime is now.
        # A floor ("after 2001") passes on 1970's two failure modes as
        # well as its own -- nfstime3.seconds is a u32, so an adapter
        # sending nanoseconds saturates it and dates every file
        # 2106-02-07, which cleared a floor for months.
        code, out = await sh("stat", "-f", "%m", f"{whole}/a.txt")
        if code != 0:
            code, out = await sh("stat", "-c", "%Y", f"{whole}/a.txt")
        stamp = int(out) if out.isdigit() else 0
        result["mtime_matches_clock"] = abs(stamp - time.time()) < 3600

        try:
            await track(manager, ws.ops, "/dev", whole)
            result["collision_rejected"] = False
        except ValueError:
            result["collision_rejected"] = True
    finally:
        await manager.close()

    io = await ws.execute("cat /d/m.txt")
    result["close_flushed"] = (await io.materialize_stdout()).decode().strip()
    result["mountpoints_cleaned"] = gone(whole) and gone(docs)


async def run_sizeless(result: dict[str, object]) -> None:
    """Size-unknown files read as empty, and the mount warns.

    Args:
        result (dict): probe results.
    """
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo hidden-content > /api.json")

    records: list[logging.LogRecord] = []
    handler = logging.Handler()
    handler.emit = records.append
    logging.getLogger("mirage.nfs.backend").addHandler(handler)

    manager = NFSManager()
    try:
        mnt = await track(manager, SizelessOps(ws.ops), "/")
        _, out = await sh("cat", f"{mnt}/api.json")
        result["sizeless_reads_empty"] = out == ""
        code, out = await sh("stat", "-f", "%z", f"{mnt}/api.json")
        if code != 0:
            code, out = await sh("stat", "-c", "%s", f"{mnt}/api.json")
        result["sizeless_stat_zero"] = out == "0"
    finally:
        await manager.close()
        logging.getLogger("mirage.nfs.backend").removeHandler(handler)
    result["sizeless_warned"] = any("read as empty" in r.getMessage()
                                    for r in records)


async def run_bigfile(result: dict[str, object]) -> None:
    """Multi-chunk md5 round-trip through a kernel mount.

    A 1 MiB copy arrives as dozens of WRITEs, and the macOS client has
    been observed issuing them out of order and overlapping -- the
    behavior that silently corrupts nfsserve's own demo example. The
    read-back happens BEFORE any flush, so it exercises the overlay
    path over the full chunk set; the workspace check after close
    proves the merged flush stored the same bytes.

    Args:
        result (dict): probe results.
    """
    payload = bytes(range(256)) * 4096
    want = hashlib.md5(payload).hexdigest()
    host_dir = tempfile.mkdtemp(prefix="mirage-nfs-big-")
    src = os.path.join(host_dir, "src.bin")
    back = os.path.join(host_dir, "back.bin")
    with open(src, "wb") as fh:
        fh.write(payload)

    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    manager = NFSManager()
    try:
        mnt = await track(manager, ws.ops, "/")
        code, _ = await sh("cp", src, f"{mnt}/big.bin")
        result["bigfile_cp_in"] = code == 0
        code, _ = await sh("cp", f"{mnt}/big.bin", back)
        result["bigfile_cp_out"] = code == 0
        with open(back, "rb") as fh:
            result["bigfile_md5_pre_flush"] = hashlib.md5(
                fh.read()).hexdigest() == want
    finally:
        await manager.close()
        # Host-side scratch, not a mountpoint: nothing unmounts it, so
        # the run that made it is the run that removes it.
        shutil.rmtree(host_dir, ignore_errors=True)
    # Verified at the ops tier, not through the executor: `cat` is the
    # agent surface and its output is capped by the post gate (a 1 MiB
    # file comes back truncated by design), while ops.read(raw=True)
    # answers the stored bytes themselves.
    stored = await ws.ops.read("/big.bin", raw=True)
    result["bigfile_md5_persisted"] = hashlib.md5(stored).hexdigest() == want


async def run_workspace_backend(result: dict[str, object]) -> None:
    """A Mount declaring backend=nfs is served by the workspace itself.

    The declaration is recorded by the constructor and mounted by the
    first await, so this also pins that ``execute`` is enough and that
    an nfs mount never shows up in the fuse view.

    Args:
        result (dict): probe results.
    """
    ws = Workspace(
        {
            "/data":
            Mount(
                RAMResource(), mode=MountMode.WRITE, backend=MountBackend.NFS)
        },
        mode=MountMode.WRITE)
    point = ""
    try:
        await ws.execute("echo declared > /data/w.txt")
        await ws.execute(
            "mkdir -p /data/docs && echo nested > /data/docs/n.txt")
        await ws.nfs_ready()
        point = ws.nfs_mountpoints["/data"]
        MOUNTPOINTS.add(point)
        _, out = await sh("cat", f"{point}/w.txt")
        result["workspace_backend_cat"] = out
        result["workspace_backend_not_fuse"] = ws.fuse_mountpoints == {}

        docs = await ws.add_nfs_mount("/data/docs")
        MOUNTPOINTS.add(docs)
        result["workspace_backend_distinct"] = docs != point
        _, out = await sh("cat", f"{docs}/n.txt")
        result["workspace_backend_second"] = out
    finally:
        await ws.close()
    result["workspace_backend_cleaned"] = (ws.nfs_mountpoints == {}
                                           and gone(point))


async def run_session_scope(result: dict[str, object]) -> None:
    """A scoped mount serves its session's grants, not the workspace's.

    The narrowing has to survive the whole round trip -- kernel client,
    server, adapter, op door -- so it is asserted through a real mount
    rather than at the adapter, where a passing test would only prove
    the wrapper was called.

    Args:
        result (dict): probe results.
    """
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo seed > /data/a.txt")
    ws.create_session("agent", mounts={"/data": "read"})
    open_point = ""
    try:
        open_point = await ws.add_nfs_mount("/data", None, EPHEMERAL)
        MOUNTPOINTS.add(open_point)
        scoped = await ws.add_nfs_mount("/data", None, EPHEMERAL, "agent")
        MOUNTPOINTS.add(scoped)
        result["session_distinct_mounts"] = scoped != open_point

        _, out = await sh("cat", f"{scoped}/a.txt")
        result["session_read"] = out
        code, _ = await sh("sh", "-c",
                           f"echo blocked > {scoped}/new.txt 2>/dev/null")
        result["session_write_refused"] = code != 0
        code, _ = await sh("sh", "-c", f"echo allowed > {open_point}/ok.txt")
        result["unscoped_write_ok"] = code == 0
    finally:
        await ws.close()
    result["session_cleaned"] = ws.nfs_mountpoints == {}


async def run_all(result: dict[str, object]) -> None:
    """Every scenario, in order.

    Args:
        result (dict): probe results, keyed for truth_nfs.json.
    """
    try:
        check_platform_nfs("win32")
        result["win32_refused"] = False
    except RuntimeError:
        result["win32_refused"] = True

    await run_battery(result)
    await run_workspace_backend(result)
    await run_session_scope(result)
    await run_sizeless(result)
    await run_bigfile(result)


async def main() -> None:
    """Run the battery under a deadline, and never leave a mount behind.

    A hung scenario has to end as a failed run rather than as a live
    mount with no server, so the whole battery is bounded and the
    teardown runs whatever the outcome.
    """
    result: dict[str, object] = {}
    try:
        await asyncio.wait_for(run_all(result),
                               timeout=BATTERY_TIMEOUT_SECONDS)
    finally:
        force_unmount_all()
    print(json.dumps(result))


# The handlers are sync (see force_unmount_all) and installed before the
# loop exists, so an interrupt at any point in the run still clears the
# mounts. They cannot help against a thread already blocked in the
# kernel, which is why nothing in this file stats a mountpoint inline.
signal.signal(signal.SIGINT, _on_signal)
signal.signal(signal.SIGTERM, _on_signal)
asyncio.run(main())
