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

import bz2
import gzip
import io
import json
import lzma
import tarfile

import pytest

from mirage.types import VFSName
from mirage.workspace.snapshot.keys import MountKey, StateKey, VFSStateKey
from mirage.workspace.snapshot.tar_io import read_tar, write_tar
from mirage.workspace.snapshot.utils import BLOB_REF_KEY


def _disk_manifest(blob: str) -> dict:
    return {
        StateKey.MOUNTS: [
            {
                MountKey.VFS_STATE: {
                    VFSStateKey.TYPE: VFSName.DISK,
                    VFSStateKey.FILES: {"f": {BLOB_REF_KEY: blob}},
                }
            }
        ]
    }


def test_a_captured_file_replaced_by_a_link_is_refused(tmp_path):
    # The tar reads a disk file after the state named it; a link put in
    # its place since must not carry a host file into the snapshot.
    captured = tmp_path / "f"
    secret = tmp_path / "secret"
    secret.write_text("host")
    captured.symlink_to(secret)
    buffer = io.BytesIO()
    with pytest.raises(OSError):
        write_tar(buffer, _disk_manifest("b/f"), {"b/f": captured})
    assert b"host" not in buffer.getvalue()


def test_a_blob_path_tar_spells_otherwise_reads_back(tmp_path):
    buffer = io.BytesIO()
    write_tar(buffer, {"k": {BLOB_REF_KEY: "./b//f"}}, {"./b//f": b"data"})
    buffer.seek(0)
    assert read_tar(buffer) == {"k": b"data"}
    buffer.seek(0)
    staging = tmp_path / "staging"
    staging.mkdir()
    state = read_tar(buffer, staging)
    assert state == {"k": b"data"}
    buffer = io.BytesIO()
    write_tar(buffer, _disk_manifest("./b//f"), {"./b//f": b"data"})
    buffer.seek(0)
    mount = read_tar(buffer, staging)[StateKey.MOUNTS][0]
    vfs_state = mount[MountKey.VFS_STATE]
    assert vfs_state[VFSStateKey.FILES]["f"] == staging / "b" / "f"


def test_one_member_named_twice_is_refused():
    with pytest.raises(ValueError, match="name one member"):
        write_tar(io.BytesIO(), {}, {"b/f": b"one", "./b//f": b"two"})
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w") as tar:
        for name, data in (
            ("manifest.json", b'{"k": {"%s": "b/f"}}' % BLOB_REF_KEY.encode()),
            ("b/f", b"one"),
            ("./b/f", b"two"),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    buffer.seek(0)
    with pytest.raises(ValueError, match="stored twice"):
        read_tar(buffer)


def test_a_staged_blob_named_elsewhere_is_read_there_too(tmp_path):
    manifest = {**_disk_manifest("b/f"), "cache": {BLOB_REF_KEY: "b/f"}}
    buffer = io.BytesIO()
    write_tar(buffer, manifest, {"b/f": b"data"})
    buffer.seek(0)
    staging = tmp_path / "staging"
    staging.mkdir()
    state = read_tar(buffer, staging)
    assert state["cache"] == b"data"
    vfs_state = state[StateKey.MOUNTS][0][MountKey.VFS_STATE]
    assert vfs_state[VFSStateKey.FILES]["f"].read_bytes() == b"data"


def test_a_staged_blob_stays_inside_the_staging_directory(tmp_path):
    buffer = io.BytesIO()
    write_tar(buffer, _disk_manifest("b/f"), {"b/f": b"data"})
    outside = tmp_path / "outside"
    outside.mkdir()
    staging = tmp_path / "staging"
    staging.mkdir()
    (staging / "b").symlink_to(outside)
    buffer.seek(0)
    with pytest.raises(ValueError, match="Unsafe blob path"):
        read_tar(buffer, staging)
    assert not (outside / "f").exists()


@pytest.mark.parametrize(
    "compressor", [None, gzip.compress, bz2.compress, lzma.compress]
)
@pytest.mark.parametrize("staging", [False, True])
def test_snapshot_budget_limits_decoded_members(tmp_path, compressor, staging):
    manifest = (
        _disk_manifest("b/f") if staging else {"blob": {BLOB_REF_KEY: "b/f"}}
    )
    buffer = io.BytesIO()
    write_tar(buffer, manifest, {"b/f": b"x" * 128_000})
    raw = buffer.getvalue()
    data = raw if compressor is None else compressor(raw)
    with pytest.raises(
        ValueError, match="snapshot exceeds expanded size limit"
    ):
        read_tar(
            io.BytesIO(data), tmp_path if staging else None, max_bytes=32_768
        )


@pytest.mark.parametrize(
    "compressor", [None, gzip.compress, bz2.compress, lzma.compress]
)
def test_snapshot_budget_limits_the_manifest(compressor):
    buffer = io.BytesIO()
    write_tar(buffer, {"padding": "x" * 128_000}, {})
    raw = buffer.getvalue()
    data = raw if compressor is None else compressor(raw)
    with pytest.raises(
        ValueError, match="snapshot exceeds expanded size limit"
    ):
        read_tar(io.BytesIO(data), max_bytes=32_768)


def test_repeated_references_share_the_restore_budget(tmp_path):
    for staging in (None, tmp_path):
        manifest = _disk_manifest("b/f") if staging else {}
        manifest["references"] = [{BLOB_REF_KEY: "./b//f"}] * 16
        buffer = io.BytesIO()
        write_tar(buffer, manifest, {"b/f": b"x" * 16_384})
        assert len(buffer.getvalue()) <= 32_768
        buffer.seek(0)
        with pytest.raises(
            ValueError, match="snapshot exceeds expanded size limit"
        ):
            read_tar(buffer, staging, max_bytes=32_768)


def test_restore_budget_boundary_and_valid_repeated_references():
    manifest = {"references": [{BLOB_REF_KEY: "b/f"}] * 16}
    buffer = io.BytesIO()
    write_tar(buffer, manifest, {"b/f": b"x" * 1024})
    budget = len(json.dumps(manifest, indent=2).encode()) + 16 * 1024
    buffer.seek(0)
    assert (
        read_tar(buffer, max_bytes=budget)["references"] == [b"x" * 1024] * 16
    )
    buffer.seek(0)
    with pytest.raises(
        ValueError, match="snapshot exceeds expanded size limit"
    ):
        read_tar(buffer, max_bytes=budget - 1)


@pytest.mark.parametrize(
    "kind",
    [
        tarfile.GNUTYPE_LONGNAME,
        tarfile.GNUTYPE_LONGLINK,
        tarfile.XHDTYPE,
        tarfile.XGLTYPE,
    ],
)
@pytest.mark.parametrize(
    "compressor", [None, gzip.compress, bz2.compress, lzma.compress]
)
def test_metadata_bodies_cannot_bypass_the_decoded_budget(kind, compressor):
    buffer = io.BytesIO()
    with tarfile.open(
        fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT
    ) as tar:
        info = tarfile.TarInfo("././@LongLink")
        info.type = kind
        info.size = 128_000
        payload = (
            b"manifest.json\x00".ljust(info.size, b"\x00")
            if kind == tarfile.GNUTYPE_LONGNAME
            else bytes(info.size)
        )
        tar.addfile(info, io.BytesIO(payload))
        info = tarfile.TarInfo("manifest.json")
        info.size = 2
        tar.addfile(info, io.BytesIO(b"{}"))
    raw = buffer.getvalue()
    data = raw if compressor is None else compressor(raw)
    with pytest.raises(
        ValueError, match="snapshot exceeds expanded size limit"
    ):
        read_tar(io.BytesIO(data), max_bytes=32_768)


@pytest.mark.parametrize(
    "path", ["manifest.json", "./manifest.json", "././manifest.json"]
)
@pytest.mark.parametrize("limit", [None, 32_768])
def test_manifest_cannot_be_a_blob_target(path, limit):
    buffer = io.BytesIO()
    manifest = {
        "padding": "x" * 16_384,
        "references": [{BLOB_REF_KEY: path}] * 16,
    }
    write_tar(buffer, manifest, {})
    buffer.seek(0)
    with pytest.raises(
        ValueError, match="Manifest cannot reference itself as a blob"
    ):
        read_tar(buffer, max_bytes=limit)
