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

import io

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
