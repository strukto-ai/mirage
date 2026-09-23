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

from mirage.types import VFSName
from mirage.vfs.base import BaseVFS
from mirage.vfs.disk.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.s3 import S3VFS


def test_base_vfs_name():
    assert BaseVFS.name == "base"


def test_disk_vfs_name():
    assert DiskVFS.name == "disk"


def test_memory_vfs_name():
    assert RAMVFS.name == "ram"


def test_s3_vfs_name():
    assert S3VFS.name == "s3"


def test_hf_buckets_vfs_name():
    assert VFSName.HF_BUCKETS.value == "hf_buckets"
