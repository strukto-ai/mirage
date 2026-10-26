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

import pytest

from mirage.vfs.base import BaseVFS
from mirage.vfs.history import HistoryViewVFS
from mirage.vfs.registry import resolve_class, resolve_entry
from tests.fixtures.vfs_io import served, vfs_over

# Every backend's op surface as the dispatcher sees it, pinned when the op
# tables became VFS methods. A diff here is a lost or gained op unless the
# change is deliberate.

SERVED = {
    "chroma": {"read", "readdir", "stat"},
    "databricks_volume": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "dify": {"read", "readdir", "stat"},
    "discord": {"read", "readdir", "stat"},
    "disk": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "dropbox": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "email": {"read", "readdir", "stat"},
    "gcal": {"read", "readdir", "stat", "unlink"},
    "gdocs": {"readdir", "rename", "stat", "unlink"},
    "gdrive": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "github": {"read", "readdir", "stat"},
    "gmail": {"read", "readdir", "stat"},
    "gsheets": {"readdir", "rename", "stat", "unlink"},
    "gslides": {"readdir", "rename", "stat", "unlink"},
    "hf_buckets": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "history": {"read", "readdir", "stat"},
    "lancedb": {"read", "readdir", "stat"},
    "langfuse": {"read", "readdir", "stat"},
    "linear": {"read", "readdir", "stat"},
    "mongodb": {"read", "readdir", "stat"},
    "nextcloud": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "notion": {"read", "readdir", "stat"},
    "onedrive": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "postgres": {"read", "readdir", "stat"},
    "qdrant": {"read", "readdir", "stat"},
    "ram": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "redis": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "s3": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "sharepoint": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "slack": {"read", "readdir", "stat"},
    "ssh": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "setattr",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "tidb_filesystem": {
        "append",
        "create",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "truncate",
        "unlink",
        "write",
    },
    "trello": {"read", "readdir", "stat"},
}

RENDERERS = {
    "gdocs": {".gdoc.json"},
    "gsheets": {".gsheet.json"},
    "gslides": {".gslide.json"},
}


def _vfs(name: str) -> BaseVFS:
    entry = resolve_entry(name)
    cls = HistoryViewVFS if entry is None else resolve_class(entry.vfs_path)
    return vfs_over(cls, None)


@pytest.mark.parametrize("name", sorted(SERVED))
def test_served_ops(name):
    assert served(_vfs(name)) == SERVED[name]


@pytest.mark.parametrize("name", sorted(SERVED))
def test_rendered_filetypes(name):
    assert set(_vfs(name).renderers) == RENDERERS.get(name, set())
