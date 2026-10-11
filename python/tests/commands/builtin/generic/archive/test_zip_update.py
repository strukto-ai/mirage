import base64
import io
import json
import struct
import zipfile
from pathlib import Path

import pytest

from mirage.commands.builtin.generic.archive.errors import ZipUpdateError
from mirage.commands.builtin.generic.archive.zip_update import (
    read_archive,
    update_archive,
)

FIXTURE = json.loads(
    (
        Path(__file__).resolve().parents[6] / "integ/fixtures/zip/update.json"
    ).read_text()
)


@pytest.mark.parametrize(
    "kind,prefix",
    [
        ("original", b""),
        ("original", b"self-extracting stub"),
        ("streamed", b""),
    ],
)
def test_preserves_opaque_members_and_metadata(kind, prefix):
    original = prefix + base64.b64decode(FIXTURE[kind])
    additions = base64.b64decode(FIXTURE["additions"])
    result = update_archive(
        read_archive(original), read_archive(additions).records
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
                for r in read_archive(original).records
                if r.name == entry.filename
            )
            assert old_record.local in result


@pytest.mark.parametrize(
    "offset,value",
    [(4, 1), (8, 0xFFFF), (10, 0xFFFF), (12, 0xFFFFFFFF), (16, 0xFFFFFFFF)],
)
def test_refuses_unsupported_end_records(offset, value):
    data = bytearray(base64.b64decode(FIXTURE["streamed"]))
    end = data.rfind(b"PK\x05\x06")
    struct.pack_into("<H" if offset < 12 else "<I", data, end + offset, value)
    with pytest.raises(ZipUpdateError):
        read_archive(bytes(data))


@pytest.mark.parametrize(
    "kind", ["truncated", "bad-local", "bad-central", "bad-offset"]
)
def test_refuses_corrupt_archives(kind):
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
        read_archive(bytes(data))
