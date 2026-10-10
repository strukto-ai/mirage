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
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from typing import IO

from mirage import Mount, MountBackend, MountMode, Workspace
from mirage.fuse.mount import mount_background, resolve_fusermount_binary
from mirage.policy import Policy
from mirage.policy.types import Deny, VfsContext, VfsResultContext
from mirage.types import FileStat, FileType
from mirage.vfs.ram import RAMVFS

# What a probe records: a captured file body or stat string, a byte
# count, an assertion that held. Mirrors the TypeScript twin's
# Record<string, string | number | boolean | null>.
ProbeValue = str | int | bool | None


class SizelessRAM(RAMVFS):
    """A caching mount whose backend names no size.

    Simulates API-backed mounts (Linear, Slack, Trello, ...) whose byte
    size is unknown until the content is fetched: over FUSE such files must
    stat as 0 until first open and read fully afterwards, and once read
    the workspace cache sizes them.
    """

    caches_reads = True

    async def stat(self, path, *args, **kwargs) -> FileStat:
        result = await super().stat(path, *args, **kwargs)
        if result.type == FileType.DIRECTORY:
            return result
        return result.model_copy(update={"size": None})


API_CONTENT = b'{"messages": 2}\n'


class SealReadsPolicy(Policy):
    """pre_vfs deny: a sealed path never reaches the backend."""

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if not ctx.write and ctx.path.virtual.endswith(".sealed"):
            return Deny("sealed")
        return None


class RedactReadsPolicy(Policy):
    """post_vfs deny: refuse read results carrying a marker."""

    async def post_vfs(self, ctx: VfsResultContext) -> Deny | None:
        data = (
            ctx.result if isinstance(ctx.result, (bytes, bytearray)) else None
        )
        if ctx.op == "read" and data is not None and b"TOPSECRET" in data:
            return Deny("redacted")
        return None


class PinLinksPolicy(Policy):
    """pre_vfs deny: a pinned link never leaves the node table."""

    async def pre_vfs(self, ctx: VfsContext) -> Deny | None:
        if ctx.op == "unlink" and ctx.path.virtual.endswith(".pinned"):
            return Deny("pinned")
        return None


def run_link_probe(result: dict[str, ProbeValue]) -> None:
    """Record that removing a link through the kernel reaches the dispatcher.

    FUSE used to drop a link straight into the namespace table, at a
    layer no policy or session view covers, so a pre_vfs deny never
    fired on one and the removal left no OpRecord. Routing the removal
    through the dispatcher is exactly what makes the two answers below
    differ, and unlink is a LINK_ENTRY_OPS member so the dispatcher answers a
    link path itself.

    Args:
        result (dict[str, ProbeValue]): the probe result to extend.
    """
    res = RAMVFS()
    res._store.dirs.add("/")
    res._store.files["/f.txt"] = b"body\n"
    ws = Workspace(
        {"/data": Mount(res, mode=MountMode.WRITE)},
        policies=[PinLinksPolicy()],
    )
    # Seeded before the mount goes live: creating a link through the
    # mountpoint would depend on libfuse's symlink argument order, which
    # is the adapter's business, not this probe's.
    asyncio.run(ws.shell("ln -s f.txt /data/lk.pinned"))
    asyncio.run(ws.shell("ln -s f.txt /data/lk.plain"))
    mountpoint = tempfile.mkdtemp(prefix="mirage-fuse-link-")
    mount_background(ws.vfs, mountpoint)
    try:
        # A denied removal must FAIL and leave the link where it was.
        # Keyed on the refusal, not on an errno, because Windows cannot
        # report one: DeleteFile only sets FileDispositionInformation,
        # so the deny lands when the handle closes and os.unlink returns
        # success on a removal that never happened. The strict EACCES is
        # therefore required only where it is observable, and the
        # surviving link is the proof everywhere.
        raised: str | None = None
        try:
            os.unlink(f"{mountpoint}/data/lk.pinned")
        except PermissionError:
            raised = "eacces"
        except OSError:
            raised = "other"
        survives = ws.namespace.is_link("/data/lk.pinned")
        result["link_policy_unlink_refused"] = survives and (
            raised == "eacces" or sys.platform == "win32"
        )
        result["link_policy_survives"] = survives
        # An unguarded link still goes, and only the link: unlink(2) on a
        # symlink leaves the pointee alone.
        os.unlink(f"{mountpoint}/data/lk.plain")
        result["link_plain_unlink_ok"] = not ws.namespace.is_link(
            "/data/lk.plain"
        )
        with open(f"{mountpoint}/data/f.txt", "rb") as fh:
            result["link_target_survives"] = fh.read().decode().strip()
        # A device reports the row the workspace's /dev answers. Windows
        # has no character devices to show one as.
        result["dev_null_char_device"] = sys.platform == "win32" or (
            stat.S_ISCHR(os.stat(f"{mountpoint}/dev/null").st_mode)
        )
    finally:
        if sys.platform == "darwin":
            subprocess.run(
                ["diskutil", "unmount", "force", mountpoint],
                capture_output=True,
            )
        elif sys.platform != "win32":
            subprocess.run(
                ["fusermount", "-u", mountpoint], capture_output=True
            )


def run_policy_probe(result: dict[str, ProbeValue]) -> None:
    """Record that op policies gate the kernel path too.

    FUSE serves the workspace's dispatcher, so a pre_vfs deny (sealed
    path) and a post_vfs deny (redacted content) must both surface as
    EACCES to ordinary file APIs, while unguarded reads pass.

    Args:
        result (dict[str, ProbeValue]): the probe result to extend.
    """
    res = RAMVFS()
    res._store.dirs.add("/")
    res._store.files["/clean.txt"] = b"hello\n"
    res._store.files["/secret.txt"] = b"TOPSECRET plans\n"
    res._store.files["/x.sealed"] = b"nope\n"
    with Workspace(
        {
            "/guarded": Mount(
                res, mode=MountMode.READ, backend=MountBackend.FUSE
            )
        },
        policies=[SealReadsPolicy(), RedactReadsPolicy()],
    ) as ws:
        mp = ws.fuse_mountpoints["/guarded"]
        with open(f"{mp}/clean.txt", "rb") as fh:
            result["policy_clean_read"] = fh.read().decode().strip()
        # A denied path must FAIL, never serve content. On FUSE the
        # refusal is EACCES; WinFsp respells the same refusal (EBADF
        # observed), so any OSError counts there and the strict errno
        # stays pinned everywhere else.
        try:
            with open(f"{mp}/x.sealed", "rb") as fh:
                fh.read()
            result["policy_sealed_eacces"] = False
        except PermissionError:
            result["policy_sealed_eacces"] = True
        except OSError:
            result["policy_sealed_eacces"] = sys.platform == "win32"
        try:
            with open(f"{mp}/secret.txt", "rb") as fh:
                fh.read()
            result["policy_redact_eacces"] = False
        except PermissionError:
            result["policy_redact_eacces"] = True
        except OSError:
            result["policy_redact_eacces"] = sys.platform == "win32"


def _absent(attempt: Callable[[], IO[bytes]]) -> bool:
    """Whether opening through the kernel answers ENOENT.

    Args:
        attempt (Callable[[], IO[bytes]]): the open to try.
    """
    try:
        with attempt():
            return False
    except FileNotFoundError:
        return True


def run_session_probe(result: dict[str, ProbeValue]) -> None:
    """Record that a session-bound kernel mount answers as its shell does.

    The session's profile hides /data/vault and caps /data at read.
    Through the kernel the hidden directory is absent: a read under
    it and a create under it both answer ENOENT and the listing omits
    it; the cap refuses a write and leaves the file as it was. The
    shell entry point run as the same session gives every answer the same
    way, and the host's own entry point still reads the hidden file, so the
    hide is the session's and not the mount's.

    Args:
        result (dict[str, ProbeValue]): the probe result to extend.
    """
    res = RAMVFS()
    res._store.dirs.add("/")
    res._store.dirs.add("/vault")
    res._store.files["/pub.txt"] = b"pub\n"
    res._store.files["/vault/secret.txt"] = b"secret\n"
    ws = Workspace({"/data": Mount(res, mode=MountMode.WRITE)})
    session = ws.create_session(
        "agent",
        profile={
            "paths": {"hide": ["/data/vault", "/data/hl"]},
            "mounts": {"/data": "read"},
        },
    )
    asyncio.run(ws.shell("ln -s pub.txt /data/hl"))
    # The shell entry point first, before the mount goes live, on the same
    # loop discipline the link probe keeps.
    hidden = asyncio.run(
        ws.shell("cat /data/vault/secret.txt", session_id="agent")
    )
    result["session_shell_hidden_exit"] = hidden.exit_code
    listing = asyncio.run(ws.shell("ls /data", session_id="agent"))
    result["session_shell_listing"] = (listing.stdout or b"").decode().strip()
    capped = asyncio.run(
        ws.shell("echo x > /data/pub.txt", session_id="agent")
    )
    result["session_shell_write_refused"] = capped.exit_code != 0
    result["session_host_reads_hidden"] = (
        asyncio.run(ws.vfs.read("/data/vault/secret.txt")).decode().strip()
    )
    asyncio.run(ws.vfs_md("/VFS.md"))
    asyncio.run(ws.skill_md("/SKILL.md", session_id="agent"))
    mountpoint = tempfile.mkdtemp(prefix="mirage-fuse-session-")
    mount_background(ws.vfs, mountpoint, session=session)
    data = f"{mountpoint}/data"
    try:
        with open(f"{data}/pub.txt", "rb") as fh:
            result["session_kernel_visible_read"] = fh.read().decode().strip()
        result["session_kernel_listing"] = ",".join(sorted(os.listdir(data)))
        result["session_kernel_hidden_absent"] = _absent(
            lambda: open(f"{data}/vault/secret.txt", "rb")
        )
        result["session_kernel_create_under_hidden_absent"] = _absent(
            lambda: open(f"{data}/vault/new.txt", "wb")
        )
        # A hidden link is absent too, not reported from the link table.
        try:
            os.lstat(f"{data}/hl")
            result["session_kernel_hidden_link_absent"] = False
        except FileNotFoundError:
            result["session_kernel_hidden_link_absent"] = True
        # The cap's refusal is an errno the adapter picks; what is
        # pinned is that the write fails and the body survives.
        try:
            with open(f"{data}/pub.txt", "wb") as fh:
                fh.write(b"x\n")
            refused = False
        except OSError:
            refused = True
        with open(f"{data}/pub.txt", "rb") as fh:
            result["session_kernel_write_refused"] = (
                refused and fh.read() == b"pub\n"
            )
        document_path = f"{mountpoint}/VFS.md"
        expected = asyncio.run(ws.vfs_md(session_id="agent")).encode()
        with open(document_path, "rb", buffering=0) as document:
            body = document.read(65536)
            result["document_kernel_profile"] = body == expected
            result["document_kernel_size"] = os.path.getsize(
                document_path
            ) == len(body)
            asyncio.run(
                ws.set_session_profile("agent", {"paths": {"hide": ["/data"]}})
            )
            document.seek(0)
            result["document_kernel_live_handle"] = (
                b"/data" not in document.read(65536)
            )
        with open(f"{mountpoint}/SKILL.md", "rb") as skill:
            result["document_kernel_skill"] = skill.read().startswith(
                b"---\nname: mirage\n"
            )
        try:
            with open(document_path, "wb") as document:
                document.write(b"changed")
            result["document_kernel_readonly"] = False
        except OSError:
            result["document_kernel_readonly"] = True
    finally:
        if sys.platform == "darwin":
            subprocess.run(
                ["diskutil", "unmount", "force", mountpoint],
                capture_output=True,
            )
        elif sys.platform != "win32":
            subprocess.run(
                ["fusermount", "-u", mountpoint], capture_output=True
            )


def run_sizeless_probe(result: dict[str, ProbeValue]) -> None:
    """Record the size-unknown semantics into the shared result.

    Args:
        result (dict[str, ProbeValue]): the probe result to extend.
    """
    api = SizelessRAM()
    api._store.dirs.add("/")
    api._store.files["/api.json"] = API_CONTENT
    ws = Workspace({"/api": Mount(api, mode=MountMode.READ)})
    mountpoint = tempfile.mkdtemp(prefix="mirage-fuse-api-")
    mount_background(ws.vfs, mountpoint)
    api_file = f"{mountpoint}/api/api.json"
    try:
        # Size-unknown semantics (see the CLAUDE.md FUSE section): stat 0
        # before open, full content on read, real size served after open.
        # Windows cannot query attributes without opening a handle, so
        # hydrate-on-open runs and even the pre-open stat sees the real size.
        pre = os.path.getsize(api_file)
        expected_pre = len(API_CONTENT) if sys.platform == "win32" else 0
        result["api_stat_preopen_ok"] = pre == expected_pre
        with open(api_file, "rb") as fh:
            result["api_cat"] = fh.read().decode().strip()
        result["api_size_postread"] = os.path.getsize(api_file)
    finally:
        if sys.platform == "darwin":
            subprocess.run(
                ["diskutil", "unmount", "force", mountpoint],
                capture_output=True,
            )
        elif sys.platform != "win32":
            # win32 has no fusermount; WinFsp unmounts on process exit.
            subprocess.run(
                ["fusermount", "-u", mountpoint], capture_output=True
            )


def run_external_unmount_probe(result: dict[str, ProbeValue]) -> None:
    """Record that a mount released from outside is removed and remounts.

    An outside unmount leaves nothing to release, so removing the mount
    must succeed with no unmount helper on PATH, and a new mount at the
    same path must serve again.

    Args:
        result (dict[str, ProbeValue]): the probe result to extend.
    """
    if sys.platform == "win32":
        # WinFsp holds a mount until the process exits, so nothing outside
        # can release it and the case does not arise.
        result["external_unmount_remounts"] = True
        return
    data = RAMVFS()
    data._store.dirs.add("/")
    data._store.files["/a.txt"] = b"alpha\n"
    mountpoint = tempfile.mkdtemp(prefix="mirage-fuse-ext-")
    outside = (
        ["diskutil", "unmount", mountpoint]
        if sys.platform == "darwin"
        else [resolve_fusermount_binary() or "fusermount", "-u", mountpoint]
    )
    with Workspace({"/x": data}) as ws:
        ws.add_fuse_mount("/x", mountpoint)
        subprocess.run(outside, capture_output=True, check=True)
        path = os.environ["PATH"]
        os.environ["PATH"] = ""
        try:
            ws.remove_fuse_mount("/x")
            released = "/x" not in ws.fuse_mountpoints
        except OSError as err:
            result["external_unmount_error"] = str(err)
            released = False
        finally:
            os.environ["PATH"] = path
        remounted = False
        if released:
            ws.add_fuse_mount("/x", mountpoint)
            with open(f"{mountpoint}/a.txt", "rb") as fh:
                remounted = fh.read() == b"alpha\n"
    result["external_unmount_remounts"] = released and remounted


def main() -> None:
    result: dict[str, ProbeValue] = {}
    data = RAMVFS()
    data._store.dirs.add("/")
    data._store.files["/a.txt"] = b"alpha\n"
    data._store.files["/s.txt"] = b"." * 20
    logs = RAMVFS()
    logs._store.dirs.add("/")
    logs._store.files["/b.txt"] = b"beta\n"

    pinned = os.path.join(
        tempfile.gettempdir(), f"mirage-fuse-data-{os.getpid()}"
    )
    shutil.rmtree(pinned, ignore_errors=True)
    # Mount via the public per-mount Mount spec (what examples/users write):
    # /data pins its mountpoint and overrides the workspace default to WRITE;
    # /logs gets a generated mountpoint and inherits the default READ.
    with Workspace(
        {
            "/data": Mount(
                data,
                mode=MountMode.WRITE,
                backend=MountBackend.FUSE,
                mountpoint=pinned,
            ),
            "/logs": Mount(logs, backend=MountBackend.FUSE),
        }
    ) as ws:
        data_mp = ws.fuse_mountpoints["/data"]
        logs_mp = ws.fuse_mountpoints["/logs"]

        with open(f"{data_mp}/a.txt", "rb") as fh:
            result["data_cat_a"] = fh.read().decode().strip()
        with open(f"{logs_mp}/b.txt", "rb") as fh:
            result["logs_cat_b"] = fh.read().decode().strip()
        result["logs_size_b"] = os.path.getsize(f"{logs_mp}/b.txt")
        # A shorter overwrite must truncate. Under libfuse 3 the kernel
        # hands O_TRUNC to open instead of sending a truncate first, and
        # a mount that ignored the flag kept the old tail (#1032).
        with open(f"{data_mp}/t.txt", "wb") as fh:
            fh.write(b"AAAAAAAAAAAAAAAAAAAA\n")
        with open(f"{data_mp}/t.txt", "wb") as fh:
            fh.write(b"BB\n")
        result["overwrite_short_size"] = os.path.getsize(f"{data_mp}/t.txt")
        with open(f"{data_mp}/t.txt", "rb") as fh:
            result["overwrite_short_body"] = fh.read().decode().strip()
        # Sparse writes on one handle stay separate runs until close,
        # arriving here from the highest offset down; they land in
        # arrival order, so the last write over offset 4 wins.
        with open(f"{data_mp}/s.txt", "r+b", buffering=0) as fh:
            for i in range(9, -1, -1):
                fh.seek(2 * i)
                fh.write(bytes([ord("a") + i]))
            fh.seek(4)
            fh.write(b"Z")
        with open(f"{data_mp}/s.txt", "rb") as fh:
            result["sparse_writes_body"] = fh.read().decode()
        # A read through the descriptor that wrote sees the write before
        # it is flushed, as on any filesystem.
        with open(f"{data_mp}/w.txt", "w+b", buffering=0) as fh:
            fh.write(b"written")
            fh.seek(0)
            result["kernel_reads_its_own_writes"] = fh.read(64).decode()
        # A chmod through the mount is stored, and an open handle reports
        # it. Windows maps a mode onto the read-only flag alone.
        os.chmod(f"{data_mp}/a.txt", 0o600)
        mode = stat.S_IMODE(os.stat(f"{data_mp}/a.txt").st_mode)
        result["kernel_chmod_kept"] = sys.platform == "win32" or mode == 0o600
        with open(f"{data_mp}/a.txt", "rb") as fh:
            fh.read()
            mode = stat.S_IMODE(os.fstat(fh.fileno()).st_mode)
        result["kernel_fstat_keeps_mode"] = (
            sys.platform == "win32" or mode == 0o600
        )
        # A create and a mkdir keep the mode they ask for, and utime,
        # touch and cp -p keep the times they set. Windows maps a mode
        # onto the read-only flag alone and has no touch or cp.
        os.close(os.open(f"{data_mp}/secret", os.O_CREAT | os.O_WRONLY, 0o600))
        os.mkdir(f"{data_mp}/private", 0o700)
        modes = tuple(
            stat.S_IMODE(os.stat(f"{data_mp}/{name}").st_mode)
            for name in ("secret", "private")
        )
        result["kernel_create_keeps_mode"] = sys.platform == "win32" or (
            modes == (0o600, 0o700)
        )
        os.utime(f"{data_mp}/a.txt", (981173106, 981173107))
        st = os.stat(f"{data_mp}/a.txt")
        result["kernel_utime_kept"] = sys.platform == "win32" or (
            (int(st.st_atime), int(st.st_mtime)) == (981173106, 981173107)
        )
        if sys.platform == "win32":
            result["kernel_cp_p_keeps_mtime"] = True
            result["kernel_touch_is_now"] = True
        else:
            subprocess.run(
                ["cp", "-p", f"{data_mp}/a.txt", f"{data_mp}/kept.txt"],
                check=True,
            )
            kept = int(os.stat(f"{data_mp}/kept.txt").st_mtime)
            result["kernel_cp_p_keeps_mtime"] = kept == 981173107
            subprocess.run(["touch", f"{data_mp}/kept.txt"], check=True)
            touched = os.stat(f"{data_mp}/kept.txt").st_mtime
            result["kernel_touch_is_now"] = abs(touched - time.time()) < 600
        result["data_pinned"] = data_mp == pinned
        result["distinct_mounts"] = data_mp != logs_mp

        result["data_mode_is_write"] = (
            ws.mount("/data").mode == MountMode.WRITE
        )
        result["logs_mode_is_read"] = ws.mount("/logs").mode == MountMode.READ

        try:
            _ = ws.fuse_mountpoint
            singular = False
        except RuntimeError:
            singular = True
        result["singular_raises_multi"] = singular

        try:
            ws.add_fuse_mount("/collide", pinned)
            collision = False
        except ValueError:
            collision = True
        result["collision_rejected"] = collision

    run_sizeless_probe(result)
    run_policy_probe(result)
    run_link_probe(result)
    run_session_probe(result)
    run_external_unmount_probe(result)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
