import base64
import io
import json
import struct
import zipfile
from pathlib import Path

import pytest

from mirage.commands.builtin.generic.archive.errors import ZipUpdateError
from mirage.commands.builtin.generic.archive.types import (
    ZipArchive,
    ZipRecord,
)
from mirage.commands.builtin.generic.archive.zip_update import (
    encode_record,
    read_archive,
    update_archive,
)
from mirage.io.spool import ByteSlice, ByteSpool
from mirage.io.types import materialize

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[6] / "integ/fixtures/zip/update.json"
    ).read_text()
)


async def _read(data: bytes) -> ZipArchive:
    spool = ByteSpool()
    await spool.append(data)
    return await read_archive(spool)


async def _update(
    original: ZipArchive | None, additions: tuple[ZipRecord, ...]
) -> bytes:
    return b"".join(
        [part async for part in update_archive(original, additions)]
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,prefix",
    [
        ("original", b""),
        ("original", b"self-extracting stub"),
        ("streamed", b""),
    ],
)
async def test_preserves_opaque_members_and_metadata(kind, prefix):
    original = prefix + base64.b64decode(FIXTURE[kind])
    additions = base64.b64decode(FIXTURE["additions"])
    result = await _update(
        await _read(original), (await _read(additions)).records
    )
    assert result.startswith(prefix)
    with (
        zipfile.ZipFile(io.BytesIO(original)) as before,
        zipfile.ZipFile(io.BytesIO(result)) as after,
    ):
        assert after.testzip() is None
        assert after.comment == before.comment
        assert after.read("target.xml") == b"updated"
        assert after.read("new.xml") == b"new"
        assert after.read("café.txt") == b"unicode"
        assert after.namelist() == before.namelist() + [
            name
            for name in ["new.xml", "target.xml", "café.txt"]
            if name not in before.namelist()
        ]
        for entry in before.infolist():
            if entry.filename in ("target.xml", "café.txt"):
                continue
            kept = after.getinfo(entry.filename)
            assert after.read(kept) == before.read(entry)
            for attr in (
                "date_time",
                "extra",
                "comment",
                "external_attr",
                "internal_attr",
                "compress_type",
                "CRC",
                "compress_size",
                "flag_bits",
            ):
                assert getattr(kept, attr) == getattr(entry, attr)
            old_record = next(
                r
                for r in (await _read(original)).records
                if r.name == entry.filename
            )
            assert await materialize(old_record.local.stream()) in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "offset,value",
    [(4, 1), (8, 0xFFFF), (10, 0xFFFF), (12, 0xFFFFFFFF), (16, 0xFFFFFFFF)],
)
async def test_refuses_unsupported_end_records(offset, value):
    data = bytearray(base64.b64decode(FIXTURE["streamed"]))
    end = data.rfind(b"PK\x05\x06")
    struct.pack_into("<H" if offset < 12 else "<I", data, end + offset, value)
    with pytest.raises(ZipUpdateError):
        await _read(bytes(data))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind", ["truncated", "bad-local", "bad-central", "bad-offset"]
)
async def test_refuses_corrupt_archives(kind):
    data = bytearray(base64.b64decode(FIXTURE["streamed"]))
    central = data.index(b"PK\x01\x02")
    if kind == "truncated":
        del data[-10:]
    elif kind == "bad-local":
        data[0] = 0
    elif kind == "bad-central":
        data[central] = 0
    else:
        struct.pack_into("<I", data, central + 42, central)
    with pytest.raises(ZipUpdateError):
        await _read(bytes(data))


@pytest.mark.asyncio
async def test_preserves_leading_bom_in_member_names():
    original = await _read(base64.b64decode(FIXTURE["bom"]))
    result = await _update(
        original,
        (await _read(base64.b64decode(FIXTURE["additions"]))).records,
    )
    with zipfile.ZipFile(io.BytesIO(result)) as archive:
        assert archive.read("\ufefftarget.xml") == b"keep BOM"
        assert archive.read("target.xml") == b"updated"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind",
    [
        "name",
        "flags",
        "method",
        "crc",
        "size",
        "local-extra",
        "central-extra",
        "local-zip64",
    ],
)
async def test_refuses_inconsistent_or_zip64_local_records(kind):
    data = bytearray(
        base64.b64decode(
            FIXTURE["local-zip64" if kind == "local-zip64" else "original"]
        )
    )
    central = data.index(b"PK\x01\x02")
    if kind == "name":
        data[30] ^= 1
    elif kind == "flags":
        data[6] ^= 1
    elif kind == "method":
        data[8] ^= 1
    elif kind == "crc":
        data[14] ^= 1
    elif kind == "size":
        struct.pack_into("<I", data, 22, 0xFFFFFFFF)
    elif kind == "local-extra":
        struct.pack_into("<H", data, 38, 1)
    elif kind == "central-extra":
        struct.pack_into("<H", data, central + 54, 1)
    with pytest.raises(ZipUpdateError):
        await _read(bytes(data))


@pytest.mark.asyncio
async def test_writes_zip64_past_the_zip32_member_count():
    spool = ByteSpool()
    head, central = encode_record(b"a", 0, 0, 0, 0, 0o100644 << 16)
    record = ZipRecord("a", ByteSlice(spool, 0, 0), central, head)
    result = await _update(None, (record,) * 0x10000)
    with zipfile.ZipFile(io.BytesIO(result)) as archive:
        assert len(archive.infolist()) == 0x10000
        assert archive.infolist()[-1].header_offset == 0xFFFF * len(head)
