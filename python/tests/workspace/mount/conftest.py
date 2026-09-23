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

import boto3
import pytest
from moto import mock_aws

from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3.s3 import S3VFS, S3Config
from mirage.workspace.mount import MountRegistry


def _ram_write(p: RAMVFS, path: str, data: bytes) -> None:
    """Write file to RAMVFS store directly (sync, for test setup)."""
    key = "/" + path.strip("/")
    parts = key.strip("/").split("/")
    for i in range(len(parts) - 1):
        p._store.dirs.add("/" + "/".join(parts[:i + 1]))
    p._store.files[key] = data


@pytest.fixture
def ram_vfs():
    """A RAMVFS with test data."""
    p = RAMVFS()
    _ram_write(p, "/hello.txt", b"hello world\n")
    _ram_write(p, "/nums.txt", b"3\n1\n2\n")
    _ram_write(p, "/sub/nested.txt", b"nested\n")
    return p


@pytest.fixture
def empty_vfs():
    """An empty RAMVFS."""
    return RAMVFS()


@pytest.fixture
def disk_vfs(tmp_path):
    """A DiskVFS backed by a temporary directory."""
    data_dir = tmp_path / "disk_data"
    data_dir.mkdir()
    (data_dir / "readme.txt").write_bytes(b"disk file\n")
    sub = data_dir / "sub"
    sub.mkdir()
    (sub / "deep.txt").write_bytes(b"deep content\n")
    return DiskVFS(root=str(data_dir))


@pytest.fixture
def s3_vfs():
    """An S3VFS backed by moto mock."""
    with mock_aws():
        conn = boto3.client("s3", region_name="us-east-1")
        conn.create_bucket(Bucket="test-bucket")
        conn.put_object(Bucket="test-bucket",
                        Key="data/report.csv",
                        Body=b"col1,col2\n1,2\n")
        conn.put_object(Bucket="test-bucket",
                        Key="data/summary.txt",
                        Body=b"summary\n")

        config = S3Config(
            bucket="test-bucket",
            region="us-east-1",
            endpoint_url=None,
        )
        yield S3VFS(config)


@pytest.fixture
def registry(ram_vfs):
    """MountRegistry with /data/ mounted to RAMVFS."""
    reg = MountRegistry()
    reg.mount("/data/", ram_vfs, MountMode.WRITE)
    return reg


@pytest.fixture
def multi_registry(s3_vfs, disk_vfs, ram_vfs):
    """MountRegistry with S3, disk, and RAM mounts."""
    reg = MountRegistry()
    reg.mount("/s3/", s3_vfs, MountMode.READ)
    reg.mount("/disk/", disk_vfs, MountMode.WRITE)
    reg.mount("/ram/", ram_vfs, MountMode.WRITE)
    return reg


@pytest.fixture
def nested_registry():
    """MountRegistry with nested prefixes."""
    p1 = RAMVFS()
    p1._store.files["/file.txt"] = b"outer\n"
    p2 = RAMVFS()
    p2._store.files["/deep.txt"] = b"inner\n"

    reg = MountRegistry()
    reg.mount("/data/", p1, MountMode.WRITE)
    reg.mount("/data/sub/", p2, MountMode.WRITE)
    return reg
