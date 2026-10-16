import struct
from collections.abc import AsyncIterator, Sequence

from mirage.commands.builtin.generic.archive.errors import ZipUpdateError
from mirage.commands.builtin.generic.archive.types import (
    ZipArchive,
    ZipRecord,
)
from mirage.io.spool import ByteSlice, ByteSpool

CP437 = "cp437"
ZIP32_MAX = 0xFFFFFFFF


def _check_extra(data: bytes) -> None:
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            raise ZipUpdateError("truncated extra field")
        tag, size = struct.unpack_from("<2H", data, pos)
        pos += 4 + size
        if tag == 1 or pos > len(data):
            raise ZipUpdateError("unsupported or truncated extra field")


async def read_archive(data: ByteSpool) -> ZipArchive:
    """Read opaque ZIP records so updates need no decompressor or password.

    Args:
        data (ByteSpool): a complete archive. ZIP64 and split archives are
            refused.
    """
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
    records: list[ZipRecord] = []
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
            ZipRecord(name, ByteSlice(data, local, limit - local), central)
        )
    return ZipArchive(
        tuple(records),
        ByteSlice(data, 0, offsets[0] if offsets else start),
        comment,
    )


def encode_record(
    name: bytes,
    method: int,
    crc: int,
    compressed: int,
    size: int,
    external_attr: int,
) -> tuple[bytes, bytes]:
    """A new member's local header and central record, the record's offset
    left for ``update_archive``; sizes past ZIP32 go in a ZIP64 field.

    Args:
        name (bytes): the UTF-8 member name.
        method (int): 0 stored, 8 deflated.
        crc (int): the CRC-32 of the uncompressed bytes.
        compressed (int): the stored byte count.
        size (int): the uncompressed byte count.
        external_attr (int): the Unix mode, shifted as Info-ZIP stores it.
    """
    large = max(size, compressed) >= ZIP32_MAX
    version = 45 if large else 20
    extra = struct.pack("<2H2Q", 1, 16, size, compressed) if large else b""
    sizes = (ZIP32_MAX, ZIP32_MAX) if large else (compressed, size)
    fields = (0x800, method, 0, 33, crc, *sizes, len(name), len(extra))
    local = struct.pack("<I5H3I2H", 0x04034B50, version, *fields)
    central = struct.pack(
        "<I6H3I5H2I",
        0x02014B50,
        (3 << 8) | version,
        version,
        *fields,
        0,
        0,
        0,
        external_attr,
        0,
    )
    return local + name + extra, central + name + extra


def _placed(central: bytes, offset: int) -> bytes:
    """``central`` pointing at its local record, through a ZIP64 field when
    the offset is past ZIP32 (after the sizes one already holds).

    Args:
        central (bytes): the record, whose own offset is not yet set.
        offset (int): where its local record starts.
    """
    record = bytearray(central)
    if offset < ZIP32_MAX:
        struct.pack_into("<I", record, 42, offset)
        return bytes(record)
    struct.pack_into("<I", record, 42, ZIP32_MAX)
    struct.pack_into("<H", record, 6, 45)
    name_len, extra_len = struct.unpack_from("<2H", record, 28)
    start = 46 + name_len
    extra = bytes(record[start : start + extra_len])
    if extra[:2] == b"\x01\x00":
        size = struct.unpack_from("<H", extra, 2)[0]
        extra = (
            struct.pack("<2H", 1, size + 8)
            + extra[4 : 4 + size]
            + struct.pack("<Q", offset)
            + extra[4 + size :]
        )
    else:
        extra = struct.pack("<2HQ", 1, 8, offset) + extra
    struct.pack_into("<H", record, 30, len(extra))
    return bytes(record[:start]) + extra + bytes(record[start + extra_len :])


async def update_archive(
    original: ZipArchive | None, additions: Sequence[ZipRecord]
) -> AsyncIterator[bytes]:
    """Replace names in place, append new ones, and copy untouched bytes,
    in ZIP64 form where the archive outgrows ZIP32.

    Args:
        original (ZipArchive | None): archive being updated, or None to
            create.
        additions (Sequence[ZipRecord]): newly encoded members.
    """
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
        central_parts.append(_placed(entry.central, offset))
        offset += len(entry.head) + entry.local.size
    directory_size = sum(map(len, central_parts))
    if original:
        async for part in original.prefix.stream():
            yield part
    for entry in records:
        if entry.head:
            yield entry.head
        async for part in entry.local.stream():
            yield part
    for part in central_parts:
        yield part
    count = len(records)
    if count >= 0xFFFF or max(offset, directory_size) >= ZIP32_MAX:
        yield struct.pack(
            "<IQ2H2I4Q",
            0x06064B50,
            44,
            45,
            45,
            0,
            0,
            count,
            count,
            directory_size,
            offset,
        )
        yield struct.pack("<2IQI", 0x07064B50, 0, offset + directory_size, 1)
    comment = original.comment if original else b""
    yield struct.pack(
        "<4s4H2IH",
        b"PK\x05\x06",
        0,
        0,
        min(count, 0xFFFF),
        min(count, 0xFFFF),
        min(directory_size, ZIP32_MAX),
        min(offset, ZIP32_MAX),
        len(comment),
    )
    yield comment
