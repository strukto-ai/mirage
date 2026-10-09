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
    "chroma": {"glob", "read", "readdir", "stat"},
    "databricks_volume": {
        "append",
        "create",
        "glob",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "rename",
        "rmdir",
        "stat",
        "unlink",
        "write",
    },
    "dify": {"glob", "read", "readdir", "stat"},
    "discord": {"glob", "read", "readdir", "stat"},
    "disk": {
        "append",
        "create",
        "glob",
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
        "glob",
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
    "email": {"glob", "read", "readdir", "stat"},
    "gcal": {"glob", "read", "readdir", "stat"},
    "gdocs": {"glob", "readdir", "stat"},
    "gdrive": {
        "append",
        "create",
        "glob",
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
    "github": {"glob", "read", "readdir", "stat"},
    "gmail": {"glob", "read", "readdir", "stat"},
    "gsheets": {"glob", "readdir", "stat"},
    "gslides": {"glob", "readdir", "stat"},
    "hf_buckets": {
        "append",
        "create",
        "glob",
        "mkdir",
        "pwrite",
        "read",
        "readdir",
        "stat",
        "unlink",
        "write",
    },
    "history": {"glob", "read", "readdir", "stat"},
    "lancedb": {"glob", "read", "readdir", "stat"},
    "langfuse": {"glob", "read", "readdir", "stat"},
    "linear": {"glob", "read", "readdir", "stat"},
    "mongodb": {"glob", "read", "readdir", "stat"},
    "nextcloud": {
        "append",
        "create",
        "glob",
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
    "notion": {"glob", "read", "readdir", "stat"},
    "onedrive": {
        "append",
        "create",
        "glob",
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
    "postgres": {"glob", "read", "readdir", "stat"},
    "qdrant": {"glob", "read", "readdir", "stat"},
    "ram": {
        "append",
        "create",
        "glob",
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
        "glob",
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
        "glob",
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
        "glob",
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
    "slack": {"glob", "read", "readdir", "stat"},
    "ssh": {
        "append",
        "create",
        "glob",
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
    "trello": {"glob", "read", "readdir", "stat"},
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
