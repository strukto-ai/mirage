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
import errno
import json
import logging
import posixpath
import stat
import struct
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field, replace
from typing import Any

from mirage.errors.fs import eacces, ebadf, eexist, efbig, enoent
from mirage.mount.constants import (
    FSPROTO_FRAME_BYTES,
    FSPROTO_VERSION,
    FSPROTO_WHOLE_BYTES,
)
from mirage.mount.core import MountCore
from mirage.mount.errors import classify_error
from mirage.mount.types import MountAttrs, ServedPrefix
from mirage.runtime.handles.mode import READ, OpenMode
from mirage.runtime.types import ByteReader, PipeWriter
from mirage.types import JsonValue
from mirage.workspace.files import Files, reader_of
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)

EMPTY = b""
# How long a barrier waits for the machine's answer before the line is
# refused.
BEGIN_WAIT_SECONDS = 15.0

Head = dict[str, Any]


@dataclass
class Frame:
    """One fsproto frame: its JSON header and its raw body.

    Args:
        head (dict[str, Any]): the header.
        body (bytes): the body.
    """

    head: Head = field(default_factory=dict)
    body: bytes = EMPTY


def encode_frame(head: Head, body: bytes = EMPTY) -> bytes:
    """``head`` and ``body`` as one frame: a big-endian u32 length, a
    big-endian u32 header length, the JSON header and the body. Mirrors
    mirage-fuse's ``proto::encode`` and TypeScript's ``encodeFrame``.

    Args:
        head (dict[str, Any]): the header.
        body (bytes): the body.
    """
    raw = json.dumps(head, separators=(",", ":")).encode()
    total = 4 + len(raw) + len(body)
    return struct.pack(">II", total, len(raw)) + raw + body


def bounded(
    head: Head, body: bytes = EMPTY, limit: int = FSPROTO_FRAME_BYTES
) -> bytes:
    """A reply as a frame the client accepts: one past ``limit`` is
    refused as ``EFBIG``, so the pipe stays usable.

    Args:
        head (dict[str, Any]): the reply's header, its ``id`` included.
        body (bytes): the reply's body.
        limit (int): the largest frame the client reads.
    """
    frame = encode_frame(head, body)
    if len(frame) - 4 <= limit:
        return frame
    return encode_frame({"id": head.get("id"), "errno": "EFBIG"})


class FrameReader:
    """The frames on a byte pipe, read one at a time."""

    async def next(self, reader: ByteReader) -> Frame | None:
        """The next frame, or None once the pipe ends between frames.

        Args:
            reader (ByteReader): the client's bytes.

        Raises:
            ValueError: a frame no client sends.
        """
        try:
            size = await reader.readexactly(4)
        except EOFError:
            return None
        (total,) = struct.unpack(">I", size)
        if total < 4 or total > FSPROTO_FRAME_BYTES:
            raise ValueError("fsproto: a frame of impossible size")
        rest = await reader.readexactly(total)
        (length,) = struct.unpack(">I", rest[:4])
        if 4 + length > total:
            raise ValueError("fsproto: a header past its frame")
        head = json.loads(rest[4 : 4 + length])
        if not isinstance(head, dict):
            raise ValueError("fsproto: a header that is not an object")
        return Frame(head, rest[4 + length :])


def workspace_path(path: JsonValue) -> str:
    """A client path as a workspace path: absolute, normalized, never
    above ``/``.

    Args:
        path (JsonValue): the path a request names.
    """
    text = path if isinstance(path, str) else ""
    return posixpath.normpath("/" + text.lstrip("/"))


def shown(rows: list[tuple[str, MountAttrs]]) -> list[tuple[str, MountAttrs]]:
    """A listing without ``.`` and ``..``, which the client adds itself.

    Args:
        rows (list[tuple[str, MountAttrs]]): the listing.
    """
    return [(name, a) for name, a in rows if name not in (".", "..")]


def child(folder: str, name: str) -> str:
    return folder + name if folder.endswith("/") else f"{folder}/{name}"


def overlaps(path: str, prefix: str) -> bool:
    """Whether a change at ``path`` reaches what is under ``prefix``.

    Args:
        path (str): the changed path.
        prefix (str): the served prefix.
    """
    a, b = path.rstrip("/"), prefix.rstrip("/")
    return a == b or b.startswith(a + "/") or a.startswith(b + "/")


def under(path: str, prefix: str) -> bool:
    """Whether ``path`` is ``prefix`` or inside it.

    Args:
        path (str): a workspace path.
        prefix (str): the served prefix.
    """
    base = prefix.rstrip("/")
    return not base or path == base or path.startswith(base + "/")


def wire(a: MountAttrs) -> Head:
    """Attributes as fsproto carries them, times in milliseconds.

    Args:
        a (MountAttrs): the attributes.
    """
    return {
        "m": a.mode,
        "s": a.size,
        "a": a.atime / 1e6,
        "t": a.mtime / 1e6,
        "c": a.ctime / 1e6,
        "n": a.nlink,
        "r": a.rdev,
    }


def num(value: JsonValue) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def whole(value: JsonValue, default: int) -> int:
    """A request's integer field, ``default`` when it sent none.

    Args:
        value (JsonValue): the field.
        default (int): what an absent field counts as.
    """
    n = num(value)
    return default if n is None else int(n)


def condition(err: BaseException) -> str:
    """The errno name fsproto carries for a failure.

    Args:
        err (BaseException): the failure.
    """
    return errno.errorcode.get(classify_error(err), "EIO")


class FsprotoServer:
    """fsproto on a byte pipe as ``session``, for a machine's mirage-fuse.

    Every request lands on one MountCore bound to the session, so the
    machine sees exactly the tree, modes and policies a shell in that
    session sees. Requests are answered one at a time in arrival order,
    as SFTP's are, so a release never overtakes the writes it settles.
    Each reply about a path says whether the client may keep it until
    told otherwise (``k``): only for a backend nothing but the workspace
    changes (``BaseVFS.sole_writer``), whose every change this server pushes to
    the client as it is noted, and ``begin`` waits until the client has
    applied them all. While a policy judges the session's file calls, no
    answer is kept, so every call a program makes reaches it.

    Args:
        files (Files): the workspace's ``ws.vfs``.
        session (SessionState): the session every request runs as.
        run (Callable[[Coroutine[Any, Any, Any]], Awaitable[Any]] | None):
            runs each request with a line's write admission; None awaits
            it here.
        served (ServedPrefix | None): the prefix the client mounts, its
            machine and the workspace's changes, which reach the client
            as invalidations.
    """

    def __init__(
        self,
        files: Files,
        session: SessionState,
        run: Callable[[Coroutine[Any, Any, Any]], Awaitable[Any]]
        | None = None,
        served: ServedPrefix | None = None,
    ) -> None:
        self._core = MountCore(files, session=session)
        self._session_id = session.session_id
        self._run = run
        self._served = served
        self._writer: PipeWriter | None = None
        self._requests: asyncio.Queue[Frame | None] = asyncio.Queue()
        self._lost: dict[int, tuple[str, Exception]] = {}
        self._told: set[int] = set()
        self._acks: dict[int, asyncio.Future[bool]] = {}
        self._invalid: dict[str, None] = {}
        self._flushing = False
        self._hid = 0
        self._ended = False
        self._keeping = False

    async def serve(self, reader: ByteReader, writer: PipeWriter) -> None:
        """Answer the client's requests until it closes the pipe.

        Args:
            reader (ByteReader): the client's requests.
            writer (PipeWriter): where the answers go.
        """
        self._writer = writer
        served = self._served
        stop = None
        if served is not None and served.changes is not None:
            stop = served.changes.watch(self._heard)
        worker = asyncio.create_task(self._work())
        frames = FrameReader()
        try:
            while True:
                frame = await frames.next(reader)
                if frame is None:
                    break
                self._take(frame)
        finally:
            if stop is not None:
                stop()
            self._ended = True
            for ack in self._acks.values():
                if not ack.done():
                    ack.set_result(False)
            self._acks.clear()
            await self._requests.put(None)
            try:
                await worker
            finally:
                await self._exit()

    async def begin(self) -> bool:
        """Wait until the client has applied every change noted so far:
        the barrier a line passes before its program starts. Once a
        policy judges the session's file calls, the client first forgets
        all it kept and refuses reads through opens its kernel may cache
        (``watch``), so each call the program makes reaches that policy.

        Returns:
            bool: False when the client did not answer within
            BEGIN_WAIT_SECONDS or its pipe ended first, so the line must
            not run on what it still keeps.
        """
        if self._ended or self._writer is None:
            return True
        served = self._served
        if served is not None and self._keeping and await self._watched():
            self._keeping = False
            self._send({"push": "watch"})
        self._flush()
        self._hid += 1
        hid = self._hid
        ack: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
        self._acks[hid] = ack
        self._send({"hid": hid, "op": "begin"})
        try:
            return await asyncio.wait_for(ack, BEGIN_WAIT_SECONDS)
        except TimeoutError:
            return False
        finally:
            self._acks.pop(hid, None)

    async def sync(self) -> list[tuple[str, Exception]]:
        """Land every write the client has been told is done, as SFTP's
        PipeServer does.

        Returns:
            list[tuple[str, Exception]]: the path and error of each
            landing that failed since the last sync, at a release or here.
        """
        failed = await self._core.sync()
        lost, self._lost = self._lost, {}
        for fh, path, err in failed:
            if fh not in self._told:
                self._told.add(fh)
                lost[fh] = (path, err)
        return list(lost.values())

    def _heard(self, path: str, by: str | None) -> None:
        served = self._served
        if served is None or by == served.machine:
            return
        if not overlaps(path, served.prefix) or not self._core.visible(path):
            return
        self._invalid[path] = None
        if not self._flushing:
            self._flushing = True
            asyncio.get_running_loop().call_soon(self._flushed)

    def _flushed(self) -> None:
        self._flushing = False
        self._flush()

    def _send(self, head: Head, body: bytes = EMPTY) -> None:
        self._write(encode_frame(head, body))

    def _write(self, frame: bytes) -> None:
        if self._writer is None or self._ended:
            return
        self._writer.write(frame)

    def _flush(self) -> None:
        if not self._invalid:
            return
        paths = list(self._invalid)
        self._invalid.clear()
        self._send({"push": "inval", "paths": paths})

    def _take(self, frame: Frame) -> None:
        hid = num(frame.head.get("hid"))
        if hid is not None:
            ack = self._acks.pop(int(hid), None)
            if ack is not None and not ack.done():
                ack.set_result(True)
            return
        if num(frame.head.get("id")) is not None:
            self._requests.put_nowait(frame)

    async def _work(self) -> None:
        while True:
            frame = await self._requests.get()
            if frame is None:
                return
            rid = frame.head["id"]
            try:
                task = self._answer(frame)
                head, body = await (
                    task if self._run is None else self._run(task)
                )
                reply = bounded({**head, "id": rid}, body)
            except Exception as err:
                reply = encode_frame({"id": rid, "errno": condition(err)})
            try:
                self._write(reply)
            except Exception as err:
                logger.debug("fsproto: answering %s failed: %r", rid, err)

    def _rows(
        self, folder: str, rows: list[tuple[str, MountAttrs]], kept: bool
    ) -> list[list[Any]]:
        """A listing on the wire: in a kept one, a folder another mount
        serves carries that mount's own ``k``.

        Args:
            folder (str): the folder listed.
            rows (list[tuple[str, MountAttrs]]): its entries.
            kept (bool): whether the folder's mount is kept.
        """
        out: list[list[Any]] = []
        for name, a in rows:
            row = wire(a)
            if kept and stat.S_ISDIR(a.mode):
                if not self._kept(child(folder, name)):
                    row["k"] = False
            out.append([name, row])
        return out

    def _kept(self, path: str) -> bool:
        """Whether the client may keep its answer about ``path`` until
        told otherwise: only on a sole writer's mount
        (``BaseVFS.sole_writer``).

        Args:
            path (str): a workspace path a reply is about.
        """
        row = reader_of(self._core.files).owner(path)
        return row is not None and row.sole_writer

    async def _keep(self, path: str) -> Head:
        """The keep fields of a reply about ``path``: ``k``, and ``w`` while
        a policy judges the session's file calls, when neither the client
        nor its kernel may keep the answer even for a moment. The watch is
        read once, and any other answer, kept or held for a second, marks
        the client as holding one for the next ``begin`` to drop.

        Args:
            path (str): a workspace path a reply is about.
        """
        if await self._watched():
            return {"k": False, "w": True}
        self._keeping = True
        return {"k": self._kept(path)}

    async def _watched(self) -> bool:
        served = self._served
        if served is None or served.watched is None:
            return False
        return await served.watched(self._session_id)

    def _path_of(self, fh: int) -> str:
        handle = self._core.handles.get(fh)
        if handle is None:
            raise ebadf(str(fh))
        return handle.path

    async def _whole(self, path: str) -> tuple[MountAttrs, bytes]:
        core = self._core
        fh = await core.open(path, READ)
        try:
            attrs = await core.fgetattr(path, fh)
            parts: list[bytes] = []
            at = 0
            while True:
                data = await core.read(path, 1024 * 1024, at, fh)
                if not data:
                    break
                parts.append(data)
                at += len(data)
                if at > FSPROTO_WHOLE_BYTES:
                    raise efbig(path)
            return replace(attrs, size=at), b"".join(parts)
        finally:
            await core.release(fh)

    def _inside(self, path: str) -> str:
        """``path``, refused as EACCES when it is outside the prefix the
        client mounts.

        Args:
            path (str): a workspace path a request names.
        """
        served = self._served
        if served is None or under(path, served.prefix):
            return path
        raise eacces(path)

    async def _answer(self, frame: Frame) -> tuple[Head, bytes]:
        h = frame.head
        core = self._core
        path = workspace_path(h.get("path"))
        if "path" in h:
            self._inside(path)
        op = h.get("op")
        if op == "hello":
            return {"proto": FSPROTO_VERSION}, EMPTY
        if op == "getattr":
            fh = num(h.get("fh"))
            if fh is not None:
                held = self._path_of(int(fh))
                return {
                    "a": wire(await core.fgetattr(held, int(fh))),
                    **await self._keep(held),
                }, EMPTY
            return {
                "a": wire(await core.getattr(path)),
                **await self._keep(path),
            }, EMPTY
        if op == "list":
            keep = await self._keep(path)
            rows = shown(await core.listing(path))
            listed = self._rows(path, rows, keep["k"])
            return {"e": listed, **keep}, EMPTY
        if op == "readall":
            attrs, data = await self._whole(path)
            return {"a": wire(attrs), **await self._keep(path)}, data
        if op == "readlink":
            return {"target": await core.readlink(path)}, EMPTY
        if op == "open":
            mode = OpenMode(
                readable=h.get("read") is not False,
                writable=h.get("write") is True,
                truncate=h.get("truncate") is True,
                append=h.get("append") is True,
                create=False,
                exclusive=False,
                binary=True,
            )
            fh = await core.open(path, mode)
            return {"fh": fh, **await self._keep(path)}, EMPTY
        if op == "create":
            mode = OpenMode(
                readable=True,
                writable=True,
                truncate=False,
                append=False,
                create=True,
                exclusive=h.get("exclusive") is True,
                binary=True,
            )
            perm = num(h.get("mode"))
            fh = await core.open(
                path, mode, None if perm is None else int(perm)
            )
            return {
                "fh": fh,
                "a": wire(await core.fgetattr(path, fh)),
                **await self._keep(path),
            }, EMPTY
        if op == "read":
            fh = whole(h.get("fh"), -1)
            data = await core.read(
                self._path_of(fh),
                whole(h.get("size"), 0),
                whole(h.get("offset"), 0),
                fh,
            )
            return {}, data
        if op == "write":
            fh = whole(h.get("fh"), -1)
            await core.write(
                self._path_of(fh),
                frame.body,
                whole(h.get("offset"), 0),
                fh,
            )
            return {}, EMPTY
        if op == "flush":
            fh = whole(h.get("fh"), -1)
            await core.flush(self._path_of(fh), fh)
            return {}, EMPTY
        if op == "release":
            fh = whole(h.get("fh"), -1)
            held = self._path_of(fh)
            try:
                await core.release(fh)
            except Exception as err:
                if fh not in self._told:
                    self._lost[fh] = (held, err)
                raise
            return {}, EMPTY
        if op == "mkdir":
            perm = num(h.get("mode"))
            await core.mkdir(path, None if perm is None else int(perm))
            return {
                "a": wire(await core.getattr(path)),
                **await self._keep(path),
            }, EMPTY
        if op == "unlink":
            await core.unlink(path)
            return {}, EMPTY
        if op == "rmdir":
            await core.rmdir(path)
            return {}, EMPTY
        if op == "symlink":
            target = h.get("target")
            await core.symlink(path, target if isinstance(target, str) else "")
            return {
                "a": wire(await core.getattr(path)),
                **await self._keep(path),
            }, EMPTY
        if op == "rename":
            old = self._inside(workspace_path(h.get("from")))
            new = self._inside(workspace_path(h.get("to")))
            if h.get("noreplace") is True and await self._exists(new):
                raise eexist(new)
            await core.rename(old, new)
            return {}, EMPTY
        if op == "setattr":
            return await self._setattr(path, h)
        if op == "statfs":
            s = core.statfs()
            return {
                "blocks": s["f_blocks"],
                "bfree": s["f_bfree"],
                "bavail": s["f_bavail"],
                "files": s["f_files"],
                "ffree": s["f_ffree"],
                "bsize": s["f_bsize"],
                "namelen": s["f_namemax"],
                "frsize": s["f_frsize"],
            }, EMPTY
        if op == "getxattr":
            return {}, await core.getxattr(path, str(h.get("name")))
        if op == "setxattr":
            flags = whole(h.get("flags"), 0)
            await core.setxattr(
                path,
                str(h.get("name")),
                frame.body,
                create=bool(flags & 1),
                replace=bool(flags & 2),
            )
            return {}, EMPTY
        if op == "listxattr":
            return {"names": await core.listxattr(path)}, EMPTY
        if op == "removexattr":
            await core.removexattr(path, str(h.get("name")))
            return {}, EMPTY
        raise ValueError(f"fsproto: no such request {op!r}")

    async def _setattr(self, path: str, h: Head) -> tuple[Head, bytes]:
        core = self._core
        fh = num(h.get("fh"))
        size = num(h.get("size"))
        mode, uid, gid = (num(h.get(k)) for k in ("mode", "uid", "gid"))
        atime, mtime = num(h.get("atime")), num(h.get("mtime"))
        rest = any(v is not None for v in (mode, uid, gid, atime, mtime))
        if fh is not None:
            path = self._path_of(int(fh))
            held = core.handles.get(int(fh))
            if rest and held is not None and held.detached is not None:
                raise enoent(path)
            if size is not None:
                await core.ftruncate(int(fh), int(size))
        elif size is not None:
            await core.truncate(path, int(size))
        if rest:
            await core.setattr(
                path,
                None if mode is None else int(mode),
                None if uid is None else int(uid),
                None if gid is None else int(gid),
                None if atime is None else int(atime * 1_000_000),
                None if mtime is None else int(mtime * 1_000_000),
            )
        attrs = (
            await core.getattr(path)
            if fh is None
            else await core.fgetattr(path, int(fh))
        )
        return {"a": wire(attrs), **await self._keep(path)}, EMPTY

    async def _exists(self, path: str) -> bool:
        try:
            await self._core.getattr(path)
        except Exception as err:
            if condition(err) == "ENOENT":
                return False
            raise
        return True

    async def _exit(self) -> None:
        first: Exception | None = None
        for fh, _ in list(self._core.handles.items()):
            release = self._core.release(fh)
            try:
                await (release if self._run is None else self._run(release))
            except Exception as err:
                first = first or err
        if self._writer is not None:
            self._writer.close()
        if first is not None:
            raise first
