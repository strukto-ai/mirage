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

import importlib
import importlib.util

import pytest

from mirage.ops.registry import RegisteredOp

# Golden snapshot of every backend's registered op surface, taken before the
# ops-layer refactor. Each row is (name, VFS, filetype, write); filetype
# "" means no filetype binding. Any diff here is a registration regression
# unless the change is deliberate.

OPTIONAL_FILETYPE_DEPS = {}

OPS_INVENTORY = {
    "chroma": [
        ("glob", "chroma", "", False),
        ("grep", "chroma", "", False),
        ("read", "chroma", "", False),
        ("readdir", "chroma", "", False),
        ("search", "chroma", "", False),
        ("stat", "chroma", "", False),
    ],
    "databricks_volume": [
        ("append", "databricks_volume", "", True),
        ("create", "databricks_volume", "", True),
        ("glob", "databricks_volume", "", False),
        ("mkdir", "databricks_volume", "", True),
        ("read", "databricks_volume", "", False),
        ("readdir", "databricks_volume", "", False),
        ("rename", "databricks_volume", "", True),
        ("rmdir", "databricks_volume", "", True),
        ("stat", "databricks_volume", "", False),
        ("unlink", "databricks_volume", "", True),
        ("write", "databricks_volume", "", True),
    ],
    "dify": [
        ("glob", "dify", "", False),
        ("grep", "dify", "", False),
        ("read", "dify", "", False),
        ("readdir", "dify", "", False),
        ("search", "dify", "", False),
        ("stat", "dify", "", False),
    ],
    "discord": [
        ("glob", "discord", "", False),
        ("read", "discord", "", False),
        ("readdir", "discord", "", False),
        ("stat", "discord", "", False),
    ],
    "disk": [
        ("append", "disk", "", True),
        ("create", "disk", "", True),
        ("glob", "disk", "", False),
        ("mkdir", "disk", "", True),
        ("read", "disk", "", False),
        ("readdir", "disk", "", False),
        ("rename", "disk", "", True),
        ("rmdir", "disk", "", True),
        ("setattr", "disk", "", True),
        ("stat", "disk", "", False),
        ("truncate", "disk", "", True),
        ("unlink", "disk", "", True),
        ("write", "disk", "", True),
    ],
    "dropbox": [
        ("append", "dropbox", "", True),
        ("create", "dropbox", "", True),
        ("glob", "dropbox", "", False),
        ("mkdir", "dropbox", "", True),
        ("read", "dropbox", "", False),
        ("readdir", "dropbox", "", False),
        ("rename", "dropbox", "", True),
        ("rmdir", "dropbox", "", True),
        ("stat", "dropbox", "", False),
        ("truncate", "dropbox", "", True),
        ("unlink", "dropbox", "", True),
        ("write", "dropbox", "", True),
    ],
    "email": [
        ("glob", "email", "", False),
        ("read", "email", "", False),
        ("readdir", "email", "", False),
        ("stat", "email", "", False),
    ],
    "gdocs": [
        ("glob", "gdocs", "", False),
        ("read", "gdocs", ".gdoc.json", False),
        ("read", "gdrive", ".gdoc.json", False),
        ("readdir", "gdocs", "", False),
        ("stat", "gdocs", "", False),
    ],
    "gdrive": [
        ("append", "gdrive", "", True),
        ("create", "gdrive", "", True),
        ("glob", "gdrive", "", False),
        ("mkdir", "gdrive", "", True),
        ("read", "gdrive", "", False),
        ("readdir", "gdrive", "", False),
        ("rename", "gdrive", "", True),
        ("rmdir", "gdrive", "", True),
        ("stat", "gdrive", "", False),
        ("truncate", "gdrive", "", True),
        ("unlink", "gdrive", "", True),
        ("write", "gdrive", "", True),
    ],
    "github": [
        ("glob", "github", "", False),
        ("read", "github", "", False),
        ("readdir", "github", "", False),
        ("stat", "github", "", False),
    ],
    "gmail": [
        ("glob", "gmail", "", False),
        ("read", "gmail", "", False),
        ("readdir", "gmail", "", False),
        ("stat", "gmail", "", False),
    ],
    "gsheets": [
        ("glob", "gsheets", "", False),
        ("read", "gdrive", ".gsheet.json", False),
        ("read", "gsheets", ".gsheet.json", False),
        ("readdir", "gsheets", "", False),
        ("stat", "gsheets", "", False),
    ],
    "gslides": [
        ("glob", "gslides", "", False),
        ("read", "gdrive", ".gslide.json", False),
        ("read", "gslides", ".gslide.json", False),
        ("readdir", "gslides", "", False),
        ("stat", "gslides", "", False),
    ],
    "hf_buckets": [
        ("append", "hf_buckets", "", True),
        ("append", "hf_datasets", "", True),
        ("append", "hf_models", "", True),
        ("append", "hf_spaces", "", True),
        ("create", "hf_buckets", "", True),
        ("create", "hf_datasets", "", True),
        ("create", "hf_models", "", True),
        ("create", "hf_spaces", "", True),
        ("glob", "hf_buckets", "", False),
        ("glob", "hf_datasets", "", False),
        ("glob", "hf_models", "", False),
        ("glob", "hf_spaces", "", False),
        ("mkdir", "hf_buckets", "", True),
        ("mkdir", "hf_datasets", "", True),
        ("mkdir", "hf_models", "", True),
        ("mkdir", "hf_spaces", "", True),
        ("read", "hf_buckets", "", False),
        ("read", "hf_datasets", "", False),
        ("read", "hf_models", "", False),
        ("read", "hf_spaces", "", False),
        ("readdir", "hf_buckets", "", False),
        ("readdir", "hf_datasets", "", False),
        ("readdir", "hf_models", "", False),
        ("readdir", "hf_spaces", "", False),
        ("stat", "hf_buckets", "", False),
        ("stat", "hf_datasets", "", False),
        ("stat", "hf_models", "", False),
        ("stat", "hf_spaces", "", False),
        ("unlink", "hf_buckets", "", True),
        ("unlink", "hf_datasets", "", True),
        ("unlink", "hf_models", "", True),
        ("unlink", "hf_spaces", "", True),
        ("write", "hf_buckets", "", True),
        ("write", "hf_datasets", "", True),
        ("write", "hf_models", "", True),
        ("write", "hf_spaces", "", True),
    ],
    "history": [
        ("glob", "history", "", False),
        ("read", "history", "", False),
        ("readdir", "history", "", False),
        ("stat", "history", "", False),
    ],
    "lancedb": [
        ("glob", "lancedb", "", False),
        ("read", "lancedb", "", False),
        ("readdir", "lancedb", "", False),
        ("stat", "lancedb", "", False),
    ],
    "langfuse": [
        ("glob", "langfuse", "", False),
        ("read", "langfuse", "", False),
        ("readdir", "langfuse", "", False),
        ("stat", "langfuse", "", False),
    ],
    "linear": [
        ("glob", "linear", "", False),
        ("read", "linear", "", False),
        ("readdir", "linear", "", False),
        ("stat", "linear", "", False),
    ],
    "mongodb": [
        ("glob", "mongodb", "", False),
        ("read", "mongodb", "", False),
        ("readdir", "mongodb", "", False),
        ("stat", "mongodb", "", False),
    ],
    "nextcloud": [
        ("append", "nextcloud", "", True),
        ("create", "nextcloud", "", True),
        ("glob", "nextcloud", "", False),
        ("mkdir", "nextcloud", "", True),
        ("read", "nextcloud", "", False),
        ("readdir", "nextcloud", "", False),
        ("rename", "nextcloud", "", True),
        ("rmdir", "nextcloud", "", True),
        ("stat", "nextcloud", "", False),
        ("truncate", "nextcloud", "", True),
        ("unlink", "nextcloud", "", True),
        ("write", "nextcloud", "", True),
    ],
    "notion": [
        ("glob", "notion", "", False),
        ("read", "notion", "", False),
        ("readdir", "notion", "", False),
        ("stat", "notion", "", False),
    ],
    "onedrive": [
        ("append", "onedrive", "", True),
        ("create", "onedrive", "", True),
        ("glob", "onedrive", "", False),
        ("mkdir", "onedrive", "", True),
        ("read", "onedrive", "", False),
        ("readdir", "onedrive", "", False),
        ("rename", "onedrive", "", True),
        ("rmdir", "onedrive", "", True),
        ("stat", "onedrive", "", False),
        ("truncate", "onedrive", "", True),
        ("unlink", "onedrive", "", True),
        ("write", "onedrive", "", True),
    ],
    "postgres": [
        ("glob", "postgres", "", False),
        ("read", "postgres", "", False),
        ("readdir", "postgres", "", False),
        ("stat", "postgres", "", False),
    ],
    "qdrant": [
        ("glob", "qdrant", "", False),
        ("read", "qdrant", "", False),
        ("readdir", "qdrant", "", False),
        ("stat", "qdrant", "", False),
    ],
    "ram": [
        ("append", "ram", "", True),
        ("create", "ram", "", True),
        ("glob", "ram", "", False),
        ("mkdir", "ram", "", True),
        ("read", "ram", "", False),
        ("readdir", "ram", "", False),
        ("rename", "ram", "", True),
        ("rmdir", "ram", "", True),
        ("setattr", "ram", "", True),
        ("stat", "ram", "", False),
        ("truncate", "ram", "", True),
        ("unlink", "ram", "", True),
        ("write", "ram", "", True),
    ],
    "redis": [
        ("append", "redis", "", True),
        ("create", "redis", "", True),
        ("glob", "redis", "", False),
        ("mkdir", "redis", "", True),
        ("read", "redis", "", False),
        ("readdir", "redis", "", False),
        ("rename", "redis", "", True),
        ("rmdir", "redis", "", True),
        ("setattr", "redis", "", True),
        ("stat", "redis", "", False),
        ("truncate", "redis", "", True),
        ("unlink", "redis", "", True),
        ("write", "redis", "", True),
    ],
    "s3": [
        ("append", "s3", "", True),
        ("create", "s3", "", True),
        ("glob", "s3", "", False),
        ("mkdir", "s3", "", True),
        ("read", "s3", "", False),
        ("readdir", "s3", "", False),
        ("rename", "s3", "", True),
        ("rmdir", "s3", "", True),
        ("stat", "s3", "", False),
        ("truncate", "s3", "", True),
        ("unlink", "s3", "", True),
        ("write", "s3", "", True),
    ],
    "sharepoint": [
        ("append", "sharepoint", "", True),
        ("create", "sharepoint", "", True),
        ("glob", "sharepoint", "", False),
        ("mkdir", "sharepoint", "", True),
        ("read", "sharepoint", "", False),
        ("readdir", "sharepoint", "", False),
        ("rename", "sharepoint", "", True),
        ("rmdir", "sharepoint", "", True),
        ("stat", "sharepoint", "", False),
        ("truncate", "sharepoint", "", True),
        ("unlink", "sharepoint", "", True),
        ("write", "sharepoint", "", True),
    ],
    "slack": [
        ("glob", "slack", "", False),
        ("read", "slack", "", False),
        ("readdir", "slack", "", False),
        ("stat", "slack", "", False),
    ],
    "ssh": [
        ("append", "ssh", "", True),
        ("create", "ssh", "", True),
        ("glob", "ssh", "", False),
        ("mkdir", "ssh", "", True),
        ("read", "ssh", "", False),
        ("readdir", "ssh", "", False),
        ("rename", "ssh", "", True),
        ("rmdir", "ssh", "", True),
        ("setattr", "ssh", "", True),
        ("stat", "ssh", "", False),
        ("truncate", "ssh", "", True),
        ("unlink", "ssh", "", True),
        ("write", "ssh", "", True),
    ],
    "trello": [
        ("glob", "trello", "", False),
        ("read", "trello", "", False),
        ("readdir", "trello", "", False),
        ("stat", "trello", "", False),
    ],
}


def _available(filetype: str) -> bool:
    dep = OPTIONAL_FILETYPE_DEPS.get(filetype)
    return dep is None or importlib.util.find_spec(dep) is not None


@pytest.mark.parametrize("backend", sorted(OPS_INVENTORY))
def test_ops_inventory(backend):
    mod = importlib.import_module(f"mirage.ops.{backend}")
    actual = set()
    for fn in mod.OPS:
        registered = ([fn]
                      if isinstance(fn, RegisteredOp) else fn._registered_ops)
        for ro in registered:
            actual.add((ro.name, ro.vfs, ro.filetype or "", ro.write))
    expected = {row for row in OPS_INVENTORY[backend] if _available(row[2])}
    assert actual == expected
