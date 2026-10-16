import struct
from collections.abc import AsyncIterator, Sequence

from mirage.commands.builtin.generic.archive.errors import ZipUpdateError
from mirage.commands.builtin.generic.archive.types import (
    SpoolZipArchive,
    SpoolZipRecord,
    ZipArchive,
    ZipRecord,
)
from mirage.io.spool import ByteSlice, ByteSpool

CP437 = "cp437"


def _check_extra(data: bytes) -> None:
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            raise ZipUpdateError("truncated extra field")
        tag, size = struct.unpack_from("<2H", data, pos)
        pos += 4 + size
        if tag == 1 or pos > len(data):
            raise ZipUpdateError("unsupported or truncated extra field")


def read_archive(data: bytes) -> ZipArchive:
    """Read opaque ZIP records so updates need no decompressor or password.

    Args:
        data (bytes): a complete archive. ZIP64 and split archives are
            refused before writing; the writer emits single-disk ZIP32.
    """
    end = len(data) - 22
    while end >= max(0, len(data) - 65557):
        if data[end : end + 4] == b"PK\x05\x06":
            fields = struct.unpack_from("<4H2IH", data, end + 4)
            disk, cd_disk, disk_count, count, size, offset, comment_len = (
                fields
            )
            if end + 22 + comment_len == len(data):
                break
        end -= 1
    else:
        raise ZipUpdateError("missing end record")
    if disk or cd_disk or disk_count != count:
        raise ZipUpdateError("split archive")
    if count == 0xFFFF or max(size, offset) == 0xFFFFFFFF:
        raise ZipUpdateError("ZIP64 archive")
    shift = end - size - offset
    start = end - size
    if shift < 0 or start < 0:
        raise ZipUpdateError("invalid directory offset")
    pos = start
    entries: list[tuple[str, bytes, int, int]] = []
    for _ in range(count):
        if pos + 46 > end or data[pos : pos + 4] != b"PK\x01\x02":
            raise ZipUpdateError("invalid directory entry")
        flags = struct.unpack_from("<H", data, pos + 8)[0]
        csize, usize = struct.unpack_from("<2I", data, pos + 20)
        name_len, extra_len, note_len, disk = struct.unpack_from(
            "<4H", data, pos + 28
        )
        local = struct.unpack_from("<I", data, pos + 42)[0]
        next_pos = pos + 46 + name_len + extra_len + note_len
        if disk or max(csize, usize, local) == 0xFFFFFFFF or next_pos > end:
            raise ZipUpdateError("unsupported or truncated entry")
        raw_name = data[pos + 46 : pos + 46 + name_len]
        _check_extra(data[pos + 46 + name_len : next_pos - note_len])
        try:
            name = raw_name.decode("utf-8" if flags & 0x800 else CP437)
        except UnicodeDecodeError as exc:
            raise ZipUpdateError("invalid entry name") from exc
        entries.append((name, data[pos:next_pos], local + shift, csize))
        pos = next_pos
    if pos != end:
        raise ZipUpdateError("invalid directory size")
    offsets = sorted(entry[2] for entry in entries)
    if len(set(offsets)) != len(offsets):
        raise ZipUpdateError("overlapping local records")
    limits = (
        dict(zip(offsets, [*offsets[1:], start], strict=True))
        if offsets
        else {}
    )
    records = []
    for name, central, local, csize in entries:
        limit = limits[local]
        if (
            local < 0
            or local + 30 > limit
            or data[local : local + 4] != b"PK\x03\x04"
        ):
            raise ZipUpdateError("invalid local record")
        name_len, extra_len = struct.unpack_from("<2H", data, local + 26)
        if local + 30 + name_len + extra_len + csize > limit:
            raise ZipUpdateError("truncated local record")
        central_name_len = struct.unpack_from("<H", central, 28)[0]
        if (
            data[local + 30 : local + 30 + name_len]
            != central[46 : 46 + central_name_len]
            or data[local + 6 : local + 10] != central[8:12]
        ):
            raise ZipUpdateError("inconsistent local record")
        if 0xFFFFFFFF in struct.unpack_from("<2I", data, local + 18):
            raise ZipUpdateError("ZIP64 local record")
        if not struct.unpack_from("<H", central, 8)[0] & 8:
            if data[local + 14 : local + 26] != central[16:28]:
                raise ZipUpdateError("inconsistent local sizes or CRC")
        _check_extra(
            data[local + 30 + name_len : local + 30 + name_len + extra_len]
        )
        records.append(ZipRecord(name, data[local:limit], central))
    return ZipArchive(
        tuple(records),
        data[: offsets[0] if offsets else start],
        data[end + 22 :],
    )


def update_archive(
    original: ZipArchive | None, additions: Sequence[ZipRecord]
) -> bytes:
    """Replace names in place, append new ones, and copy untouched bytes.

    Args:
        original (ZipArchive | None): archive being updated, or None to create.
        additions (Sequence[ZipRecord]): newly encoded members.
    """
    original = original or ZipArchive((), b"", b"")
    replacements = {entry.name: entry for entry in additions}
    old_names = {entry.name for entry in original.records}
    records = [
        replacements.get(entry.name, entry) for entry in original.records
    ]
    records.extend(entry for entry in additions if entry.name not in old_names)
    local_parts = [original.prefix]
    central_parts = []
    offset = len(original.prefix)
    for entry in records:
        if offset >= 0xFFFFFFFF:
            raise ZipUpdateError("ZIP64 required")
        central = bytearray(entry.central)
        struct.pack_into("<I", central, 42, offset)
        central_parts.append(central)
        local_parts.append(entry.local)
        offset += len(entry.local)
    directory = b"".join(central_parts)
    if len(records) >= 0xFFFF or max(offset, len(directory)) >= 0xFFFFFFFF:
        raise ZipUpdateError("ZIP64 required")
    end = struct.pack(
        "<4s4H2IH",
        b"PK\x05\x06",
        0,
        0,
        len(records),
        len(records),
        len(directory),
        offset,
        len(original.comment),
    )
    return b"".join((*local_parts, directory, end, original.comment))


async def read_spooled_archive(data: ByteSpool) -> SpoolZipArchive:
    tail_start = max(0, data.size - 65557)
    tail = await data.read(tail_start, data.size - tail_start)
    end = len(tail) - 22
    while end >= 0:
        if tail[end : end + 4] == b"PK\x05\x06":
            disk, cd_disk, disk_count, count, size, offset, comment_len = (
                struct.unpack_from("<4H2IH", tail, end + 4)
            )
            if end + 22 + comment_len == len(tail):
                break
        end -= 1
    else:
        raise ZipUpdateError("missing end record")
    comment = tail[end + 22 :]
    end += tail_start
    if disk or cd_disk or disk_count != count:
        raise ZipUpdateError("split archive")
    if count == 0xFFFF or max(size, offset) == 0xFFFFFFFF:
        raise ZipUpdateError("ZIP64 archive")
    shift, start = end - size - offset, end - size
    if shift < 0 or start < 0:
        raise ZipUpdateError("invalid directory offset")
    pos = start
    entries: list[tuple[str, bytes, int, int]] = []
    for _ in range(count):
        header = await data.read(pos, 46)
        if pos + 46 > end or header[:4] != b"PK\x01\x02":
            raise ZipUpdateError("invalid directory entry")
        flags = struct.unpack_from("<H", header, 8)[0]
        csize, usize = struct.unpack_from("<2I", header, 20)
        name_len, extra_len, note_len, disk = struct.unpack_from(
            "<4H", header, 28
        )
        local = struct.unpack_from("<I", header, 42)[0]
        next_pos = pos + 46 + name_len + extra_len + note_len
        if disk or max(csize, usize, local) == 0xFFFFFFFF or next_pos > end:
            raise ZipUpdateError("unsupported or truncated entry")
        central = header + await data.read(
            pos + 46, name_len + extra_len + note_len
        )
        _check_extra(central[46 + name_len : 46 + name_len + extra_len])
        try:
            name = central[46 : 46 + name_len].decode(
                "utf-8" if flags & 0x800 else CP437
            )
        except UnicodeDecodeError as exc:
            raise ZipUpdateError("invalid entry name") from exc
        entries.append((name, central, local + shift, csize))
        pos = next_pos
    if pos != end:
        raise ZipUpdateError("invalid directory size")
    offsets = sorted(entry[2] for entry in entries)
    if len(set(offsets)) != len(offsets):
        raise ZipUpdateError("overlapping local records")
    limits = (
        dict(zip(offsets, [*offsets[1:], start], strict=True))
        if offsets
        else {}
    )
    records: list[SpoolZipRecord] = []
    for name, central, local, csize in entries:
        limit = limits[local]
        if local < 0 or local + 30 > limit:
            raise ZipUpdateError("invalid local record")
        header = await data.read(local, 30)
        if header[:4] != b"PK\x03\x04":
            raise ZipUpdateError("invalid local record")
        name_len, extra_len = struct.unpack_from("<2H", header, 26)
        if local + 30 + name_len + extra_len + csize > limit:
            raise ZipUpdateError("truncated local record")
        extra = await data.read(local + 30, name_len + extra_len)
        central_name_len = struct.unpack_from("<H", central, 28)[0]
        if (
            extra[:name_len] != central[46 : 46 + central_name_len]
            or header[6:10] != central[8:12]
        ):
            raise ZipUpdateError("inconsistent local record")
        if 0xFFFFFFFF in struct.unpack_from("<2I", header, 18):
            raise ZipUpdateError("ZIP64 local record")
        if (
            not struct.unpack_from("<H", central, 8)[0] & 8
            and header[14:26] != central[16:28]
        ):
            raise ZipUpdateError("inconsistent local sizes or CRC")
        _check_extra(extra[name_len:])
        records.append(
            SpoolZipRecord(
                name, ByteSlice(data, local, limit - local), central
            )
        )
    return SpoolZipArchive(
        tuple(records),
        ByteSlice(data, 0, offsets[0] if offsets else start),
        comment,
    )


async def update_spooled_archive(
    original: SpoolZipArchive | None, additions: Sequence[SpoolZipRecord]
) -> AsyncIterator[bytes]:
    replacements = {entry.name: entry for entry in additions}
    old_names = (
        {entry.name for entry in original.records} if original else set()
    )
    records = (
        [replacements.get(entry.name, entry) for entry in original.records]
        if original
        else []
    )
    records.extend(entry for entry in additions if entry.name not in old_names)
    offset = original.prefix.size if original else 0
    central_parts = []
    for entry in records:
        if offset >= 0xFFFFFFFF:
            raise ZipUpdateError("ZIP64 required")
        central = bytearray(entry.central)
        struct.pack_into("<I", central, 42, offset)
        central_parts.append(bytes(central))
        offset += entry.local.size
    directory_size = sum(map(len, central_parts))
    if len(records) >= 0xFFFF or max(offset, directory_size) >= 0xFFFFFFFF:
        raise ZipUpdateError("ZIP64 required")
    if original:
        async for part in original.prefix.stream():
            yield part
    for entry in records:
        async for part in entry.local.stream():
            yield part
    for part in central_parts:
        yield part
    comment = original.comment if original else b""
    yield struct.pack(
        "<4s4H2IH",
        b"PK\x05\x06",
        0,
        0,
        len(records),
        len(records),
        directory_size,
        offset,
        len(comment),
    )
    yield comment
