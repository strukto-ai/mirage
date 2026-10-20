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
import bisect
import errno
import logging
import os
import posixpath
import subprocess
import sys
import time
from functools import partial

from mirage.bridge.sync import on_auxiliary_loop
from mirage.mount.constants import (
    LISTING_CONCURRENCY,
    OPEN_HANDLES,
    RESERVED_PORTS,
)
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.mount.types import MountAttrs
from mirage.rs.errors import StreamRefusal
from mirage.rs.nfs import NFSEngine, NFSRequest
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

HOST = "127.0.0.1"
LINUX_OPTIONS = (
    "vers=3,proto=tcp,mountproto=tcp,mountvers=3,nolock,soft,timeo=50,"
    "retrans=2,ro,addr=127.0.0.1,mountaddr=127.0.0.1"
)
DARWIN_OPTIONS = (
    "vers=3,tcp,nolocks,soft,intr,timeo=50,retrans=2,deadtimeout=60,"
    "rdonly,noresvport"
)
MOUNT_TIMEOUT = 30


def mount_args(
    port: int, mountpoint: str, platform: str = sys.platform
) -> list[str]:
    """The system command that mounts the server on ``port`` at
    ``mountpoint``: read-only and soft, so an I/O against a server that
    went away fails rather than hangs.

    Args:
        port (int): the port the server listens on, for NFS and MOUNT.
        mountpoint (str): the directory to mount on.
        platform (str): ``sys.platform`` of the machine mounting.

    Raises:
        RuntimeError: the platform has no NFS client mirage drives.
    """
    ports = f"port={port},mountport={port}"
    if platform == "darwin":
        options = f"{DARWIN_OPTIONS},{ports}"
        return ["/sbin/mount_nfs", "-o", options, f"{HOST}:/", mountpoint]
    if platform.startswith("linux"):
        options = f"{LINUX_OPTIONS},{ports}"
        return ["mount", "-t", "nfs", "-o", options, f"{HOST}:/", mountpoint]
    raise RuntimeError(
        f"the nfs mount backend runs on Linux and macOS, not {platform!r}; "
        "use backend='fuse'"
    )


def unmount_args(
    mountpoint: str, platform: str = sys.platform
) -> list[list[str]]:
    """The commands that unmount ``mountpoint``, tried in order until one
    succeeds: a plain unmount, then a forced or lazy one.

    Args:
        mountpoint (str): the mounted directory.
        platform (str): ``sys.platform`` of the machine.
    """
    if platform == "darwin":
        return [
            ["umount", mountpoint],
            ["diskutil", "unmount", "force", mountpoint],
        ]
    return [["umount", mountpoint], ["umount", "-l", mountpoint]]


def mount_nfs(port: int, mountpoint: str) -> None:
    """Mount the server on ``port`` at ``mountpoint``.

    Args:
        port (int): the port the server listens on.
        mountpoint (str): the directory to mount on.

    Raises:
        RuntimeError: the system mount refused.
    """
    done = subprocess.run(
        mount_args(port, mountpoint),
        capture_output=True,
        text=True,
        timeout=MOUNT_TIMEOUT,
    )
    if done.returncode == 0:
        return
    reason = done.stderr.strip() or f"exit {done.returncode}"
    if sys.platform.startswith("linux") and os.geteuid() != 0:
        reason += "; mounting NFS needs root on Linux, or use backend='fuse'"
    raise RuntimeError(f"nfs mount at {mountpoint} failed: {reason}")


def unmount_nfs(mountpoint: str) -> None:
    """Unmount ``mountpoint``, forcing it when a plain unmount is refused.

    Args:
        mountpoint (str): the mounted directory.
    """
    for args in unmount_args(mountpoint):
        try:
            done = subprocess.run(
                args, capture_output=True, text=True, timeout=MOUNT_TIMEOUT
            )
        except (subprocess.TimeoutExpired, OSError) as exc:
            logger.debug("nfs: %s failed: %r", " ".join(args), exc)
            continue
        if done.returncode == 0:
            return
        logger.debug("nfs: %s failed: %s", " ".join(args), done.stderr.strip())
    logger.warning("nfs: %s is still mounted", mountpoint)


def wire_time(ns: int) -> list[JsonValue]:
    """A time as NFS carries it: ``[seconds, nanoseconds]``.

    Args:
        ns (int): nanoseconds since the epoch; before it reads as the epoch.
    """
    seconds, rest = divmod(max(ns, 0), 1_000_000_000)
    return [seconds, rest]


def wire_attrs(attrs: MountAttrs) -> dict[str, JsonValue]:
    """One entry's attributes as the engine reads them.

    Args:
        attrs (MountAttrs): what the core answered.
    """
    return {
        "mode": attrs.mode,
        "size": attrs.size,
        "nlink": attrs.nlink,
        "uid": attrs.uid,
        "gid": attrs.gid,
        "atime": wire_time(attrs.atime),
        "mtime": wire_time(attrs.mtime),
        "ctime": wire_time(attrs.ctime),
    }


class MirageNFSServer:
    """An NFSv3 server over a mount core, on a local TCP port.

    The protocol is mirage-rs's (``NFSEngine``); this owns the sockets
    and runs each file operation the engine asks for on the core, so a
    kernel NFS client mounts the core's tree with no driver installed.
    NFS has no open or close: a read opens its file on the core and
    later reads reuse that handle until the file's size or mtime moves
    or the bound session changes, so a new hide or grant holds.

    Args:
        core (MountCore): the mount core to serve.
        export (str): the path a client mounts.
        secure (bool): take only clients on a reserved port, as a kernel
            client mounted by root is; on by default on Linux.
    """

    def __init__(
        self,
        core: MountCore,
        export: str = "/",
        secure: bool = sys.platform.startswith("linux"),
    ) -> None:
        self._core = core
        self._export = export
        self._secure = secure
        self._engine: NFSEngine | None = None
        self._server: asyncio.Server | None = None
        self._writers: dict[int, asyncio.StreamWriter] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._next_conn = 0
        self._stats = asyncio.Semaphore(LISTING_CONCURRENCY)
        self._handles: dict[str, asyncio.Future[int]] = {}
        self._versions: dict[str, tuple[int, int]] = {}
        self._readers: dict[str, int] = {}
        self._generation: int | None = None

    async def start(self, host: str = "127.0.0.1", port: int = 0) -> int:
        """Listen on ``host``, and return the port a client mounts.

        Args:
            host (str): the address to listen on.
            port (int): the port, or 0 for any free one.
        """
        self._server = await asyncio.start_server(self._serve, host, port)
        bound = int(self._server.sockets[0].getsockname()[1])
        self._engine = NFSEngine(
            self._export, time.time_ns() // 1_000_000, bound
        )
        return bound

    async def close(self) -> None:
        """Stop listening, drop every connection and release every
        file the server holds open."""
        self._engine = None
        if self._server is not None:
            self._server.close()
        for writer in list(self._writers.values()):
            writer.close()
        for task in list(self._tasks):
            task.cancel()
        await on_auxiliary_loop(self._release_all)
        if self._server is not None:
            await self._server.wait_closed()

    async def _serve(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        port = int(writer.get_extra_info("peername")[1])
        if self._secure and port >= RESERVED_PORTS:
            logger.warning("nfs: refused a client on unreserved port %d", port)
            writer.close()
            return
        engine = self._engine
        if engine is None:
            writer.close()
            return
        self._next_conn += 1
        conn = self._next_conn
        self._writers[conn] = writer
        try:
            while data := await reader.read(256 * 1024):
                try:
                    out = engine.feed(conn, data)
                except StreamRefusal as exc:
                    logger.debug("nfs: connection %d refused: %s", conn, exc)
                    break
                if out:
                    writer.write(out)
                self._dispatch(engine)
                await writer.drain()
        except ConnectionError as exc:
            logger.debug("nfs: connection %d dropped: %r", conn, exc)
        finally:
            self._writers.pop(conn, None)
            engine.close(conn)
            writer.close()

    def _dispatch(self, engine: NFSEngine) -> None:
        for request in engine.requests():
            task = asyncio.create_task(self._run(engine, request))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _run(self, engine: NFSEngine, request: NFSRequest) -> None:
        reply, data = await on_auxiliary_loop(partial(self._answer, request))
        if self._engine is not engine:
            return
        conn, out = engine.complete(request["id"], reply, data)
        writer = self._writers.get(conn) if conn is not None else None
        if writer is not None and out:
            writer.write(out)
        self._dispatch(engine)

    async def _answer(
        self, request: NFSRequest
    ) -> tuple[dict[str, JsonValue], bytes]:
        path = request["path"]
        try:
            match request["op"]:
                case "getattr":
                    return {
                        "attrs": wire_attrs(await self._getattr(path))
                    }, b""
                case "readdir":
                    entries, end = await self._listing(
                        path, request.get("after"), request.get("limit", 0)
                    )
                    return {"entries": entries, "end": end}, b""
                case "read":
                    offset, size = (
                        request.get("offset", 0),
                        request.get("size", 0),
                    )
                    return {}, await self._read(path, offset, size)
                case "readlink":
                    return {"target": await self._core.readlink(path)}, b""
                case op:
                    raise NotImplementedError(f"nfs: no such request {op!r}")
        except Exception as exc:
            code = classify_error(exc)
            logger.debug("nfs: %s %s: %r", request["op"], path, exc)
            return {"error": errno.errorcode.get(code, "EIO")}, b""

    async def _listing(
        self, path: str, after: str | None, limit: int
    ) -> tuple[list[JsonValue], bool]:
        async def entry(name: str) -> JsonValue:
            async with self._stats:
                try:
                    attrs = await self._core.getattr(
                        posixpath.join(path, name)
                    )
                except (FileNotFoundError, NotADirectoryError) as exc:
                    logger.debug(
                        "nfs: %s vanished while listing: %r", name, exc
                    )
                    return {"name": name, "attrs": None}
            return {"name": name, "attrs": wire_attrs(attrs)}

        names = sorted(
            n for n in await self._core.readdir(path) if n not in (".", "..")
        )
        start = 0 if after is None else bisect.bisect_right(names, after)
        page = names[start : start + limit]
        rows = list(await asyncio.gather(*(entry(name) for name in page)))
        return rows, start + limit >= len(names)

    async def _getattr(self, path: str) -> MountAttrs:
        attrs = await self._core.getattr(path)
        held = self._versions.get(path)
        if held is not None and held != (attrs.mtime, attrs.size):
            await self._release(path)
        return attrs

    async def _read(self, path: str, offset: int, size: int) -> bytes:
        session = self._core.session
        generation = None if session is None else session.generation
        if generation != self._generation:
            self._generation = generation
            await self._release_all()
        self._readers[path] = self._readers.get(path, 0) + 1
        try:
            while True:
                opened = self._handles.pop(path, None)
                if opened is None:
                    opened = asyncio.ensure_future(
                        self._open(path, self._versions)
                    )
                self._handles[path] = opened
                while len(self._handles) > OPEN_HANDLES:
                    idle = next(
                        (p for p in self._handles if p not in self._readers),
                        None,
                    )
                    if idle is None:
                        break
                    await self._release(idle)
                try:
                    fh = await asyncio.shield(opened)
                except Exception:
                    if self._handles.get(path) is opened:
                        del self._handles[path]
                    raise
                if self._handles.get(path) is opened:
                    return await self._core.read(path, size, offset, fh)
        finally:
            self._readers[path] -= 1
            if not self._readers[path]:
                del self._readers[path]

    async def _open(
        self, path: str, versions: dict[str, tuple[int, int]]
    ) -> int:
        attrs = await self._core.getattr(path)
        fh = await self._core.open(path)
        versions[path] = (attrs.mtime, attrs.size)
        return fh

    async def _release(self, path: str) -> None:
        opened = self._handles.pop(path, None)
        if opened is None:
            return
        try:
            fh = await opened
        except Exception as exc:
            logger.debug("nfs: %s never opened: %r", path, exc)
            return
        finally:
            if path not in self._handles:
                self._versions.pop(path, None)
        await self._core.release(fh)

    async def _release_all(self) -> None:
        held = self._handles
        self._handles, self._versions = {}, {}
        for path, opened in held.items():
            try:
                fh = await opened
            except Exception as exc:
                logger.debug("nfs: %s never opened: %r", path, exc)
                continue
            await self._core.release(fh)
