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

import hashlib
import zlib
from collections import OrderedDict
from collections.abc import AsyncGenerator
from io import BytesIO
from typing import NamedTuple

from dulwich.objects import object_class
from dulwich.pack import OFS_DELTA, apply_delta, write_pack_index

from mirage.commands.cli.builtin.git.constants import (
    IDX_SUFFIX,
    PACK_BLOCK,
    PACK_BLOCKS,
    PACK_DIR,
)
from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.io import (
    ensure_dir,
    exists,
    read_range,
    remove_file,
)
from mirage.rs.errors import StreamRefusal
from mirage.rs.stream import open_stream
from mirage.types import PathSpec
from mirage.utils.ids import IdSource
from mirage.workspace.files import Files


class Scanned(NamedTuple):
    """One entry the scan listed.

    Args:
        offset (int): where its entry starts in the pack.
        data (int): where its compressed bytes start.
        end (int): where they end.
        crc (int): the CRC-32 of the whole entry.
        kind (int): its pack type: 1 to 4 whole, 6 or 7 a delta.
        base (bytes): its hex id when whole, its base's offset for an
            offset delta, its base's hex id for a reference delta.
    """

    offset: int
    data: int
    end: int
    crc: int
    kind: int
    base: bytes


def pack_index(
    entries: list[tuple[bytes, int, int]], checksum: bytes
) -> bytes:
    """A pack's v2 index: its sorted names, their CRCs and offsets, the
    pack's checksum and its own.

    Args:
        entries (list[tuple[bytes, int, int]]): each object's binary id,
            offset and CRC-32, sorted by id.
        checksum (bytes): the pack's own checksum, binary.
    """
    out = BytesIO()
    write_pack_index(out, entries, checksum, version=2)
    return out.getvalue()


async def delta_ids(
    vfs: Files, path: PathSpec, scanned: list[Scanned]
) -> dict[int, bytes]:
    """Each delta's id, read back from the stored pack.

    A base's content is read once and every delta on it rebuilt from
    it, depth first, so only the chain being rebuilt is held. The pack
    is read a block at a time, the last few blocks kept, since the
    objects of a pack sit side by side.

    Args:
        vfs (Files): the session's files.
        path (PathSpec): the stored pack.
        scanned (list[Scanned]): every entry the scan listed.
    """
    ids: dict[int, bytes] = {}
    on_offset: dict[int, list[Scanned]] = {}
    on_id: dict[bytes, list[Scanned]] = {}
    for entry in scanned:
        if entry.kind < OFS_DELTA:
            ids[entry.offset] = entry.base
        elif entry.kind == OFS_DELTA:
            on_offset.setdefault(int(entry.base), []).append(entry)
        else:
            on_id.setdefault(entry.base, []).append(entry)
    kept: OrderedDict[int, bytes] = OrderedDict()

    async def content(entry: Scanned) -> bytes:
        length = entry.end - entry.data
        if length > PACK_BLOCK * 4:
            return zlib.decompress(
                await read_range(vfs, path, entry.data, length)
            )
        pieces: list[bytes] = []
        at = entry.data
        while at < entry.end:
            index = at // PACK_BLOCK
            block = kept.pop(index, None)
            if block is None:
                block = await read_range(
                    vfs, path, index * PACK_BLOCK, PACK_BLOCK
                )
                if len(kept) >= PACK_BLOCKS:
                    kept.popitem(last=False)
            kept[index] = block
            piece = block[
                at - index * PACK_BLOCK : entry.end - index * PACK_BLOCK
            ]
            if not piece:
                break
            pieces.append(piece)
            at += len(piece)
        return zlib.decompress(b"".join(pieces))

    def children(offset: int, oid: bytes) -> list[Scanned]:
        return on_offset.pop(offset, []) + on_id.pop(oid, [])

    for entry in scanned:
        if entry.kind >= OFS_DELTA or (
            entry.offset not in on_offset and entry.base not in on_id
        ):
            continue
        cls = object_class(entry.kind)
        if cls is None:
            raise GitError(
                f"pack has bad object at offset {entry.offset}: "
                f"unknown object type {entry.kind}"
            )
        kind = cls.type_name
        stack = [(await content(entry), children(entry.offset, entry.base))]
        while stack:
            base, waiting = stack[-1]
            if not waiting:
                stack.pop()
                continue
            child = waiting.pop(0)
            rebuilt = b"".join(apply_delta(base, await content(child)))
            if not waiting:
                stack.pop()
            oid = (
                hashlib.sha1(b"%s %d\0" % (kind, len(rebuilt)) + rebuilt)
                .hexdigest()
                .encode()
            )
            ids[child.offset] = oid
            stack.append((rebuilt, children(child.offset, oid)))
    left = sum(map(len, on_offset.values())) + sum(map(len, on_id.values()))
    if left:
        raise GitError(
            f"pack has {left} unresolved delta{'' if left == 1 else 's'}"
        )
    return ids


def token(ids: IdSource) -> str:
    """Six hex digits that name a temporary pack, as git's mkstemp does.

    Args:
        ids (IdSource): where the digits are drawn from.
    """
    return ids.secure_bytes(3).hex()


async def store_pack(
    vfs: Files,
    commondir: PathSpec,
    chunks: AsyncGenerator[bytes, None],
    ids: IdSource,
) -> None:
    """Keep a fetched pack whole, beside the index git reads it through,
    as it arrives.

    The bytes go straight to a temporary file while a scan lists each
    entry, then each delta's id is worked out from the stored bytes and
    the index is written. Nothing holds the pack itself, so a clone
    costs one object's bytes at a time, not the repository's.

    Named by the pack's own checksum, as git names one it receives. The
    index is written aside and renamed in after the pack, as git does,
    so a reader that lists ``.idx`` files never finds one cut short or
    one whose pack is not there yet. An empty pack stores nothing.

    Args:
        vfs (Files): the session's files.
        commondir (PathSpec): the shared git directory, which owns the
            object database.
        chunks (AsyncGenerator[bytes, None]): the packfile, as it
            arrives.
        ids (IdSource): where the temporary file's name is drawn from.
    """
    head = b""
    while not head:
        try:
            head = await anext(chunks)
        except StopAsyncIteration:
            return
    directory = commondir.join(PACK_DIR)
    await ensure_dir(vfs, directory)
    temporary = directory.join(f"tmp_pack_{token(ids)}")
    staged = directory.join(f"tmp_idx_{token(ids)}")
    scan = open_stream("git_pack", {})
    scanned: list[Scanned] = []
    checksum = b""
    partial = b""

    def take(out: bytes) -> None:
        nonlocal checksum, partial
        lines = (partial + out).split(b"\n")
        partial = lines.pop()
        for line in lines:
            fields = line.split(b" ")
            if len(fields) == 1:
                checksum = line
                continue
            offset, data, end, crc, kind, base = fields
            scanned.append(
                Scanned(
                    int(offset), int(data), int(end), int(crc), int(kind), base
                )
            )

    async def fed() -> AsyncGenerator[bytes, None]:
        take(scan.feed(head))
        yield head
        async for chunk in chunks:
            take(scan.feed(chunk))
            yield chunk
        take(scan.finish())

    try:
        try:
            await vfs.write(temporary, fed())
        except StreamRefusal as exc:
            raise GitError(exc.message) from exc
        finally:
            scan.close()
            await chunks.aclose()
        named = await delta_ids(vfs, temporary, scanned)
        entries = sorted(
            (bytes.fromhex(named[e.offset].decode()), e.offset, e.crc)
            for e in scanned
        )
        stem = f"pack-{checksum.decode()}"
        if await exists(vfs, directory.join(f"{stem}{IDX_SUFFIX}")):
            await remove_file(vfs, temporary)
            return
        index = pack_index(entries, bytes.fromhex(checksum.decode()))
        await vfs.write(staged, index)
        await vfs.rename(temporary, directory.join(f"{stem}.pack"))
        await vfs.rename(staged, directory.join(f"{stem}{IDX_SUFFIX}"))
    except BaseException:
        await remove_file(vfs, temporary)
        await remove_file(vfs, staged)
        raise
