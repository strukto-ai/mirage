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
# ops-layer refactor. Each row is (name, resource, filetype, write); filetype
# "" means no filetype binding. Any diff here is a registration regression
# unless the change is deliberate.

OPTIONAL_FILETYPE_DEPS = {
    ".parquet": "pyarrow",
    ".feather": "pyarrow",
    ".orc": "pyarrow",
    ".hdf5": "h5py",
}

OPS_INVENTORY = {
    "chroma": [
        ("grep", "chroma", "", False),
        ("read", "chroma", "", False),
        ("readdir", "chroma", "", False),
        ("search", "chroma", "", False),
        ("stat", "chroma", "", False),
    ],
    "databricks_volume": [
        ("create", "databricks_volume", "", True),
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
        ("grep", "dify", "", False),
        ("read", "dify", "", False),
        ("readdir", "dify", "", False),
        ("search", "dify", "", False),
        ("stat", "dify", "", False),
    ],
    "discord": [
        ("read", "discord", "", False),
        ("readdir", "discord", "", False),
        ("stat", "discord", "", False),
    ],
    "disk": [
        ("append", "disk", "", True),
        ("create", "disk", "", True),
        ("mkdir", "disk", "", True),
        ("read", "disk", "", False),
        ("read", "disk", ".feather", False),
        ("read", "disk", ".hdf5", False),
        ("read", "disk", ".orc", False),
        ("read", "disk", ".parquet", False),
        ("readdir", "disk", "", False),
        ("rename", "disk", "", True),
        ("rmdir", "disk", "", True),
        ("setattr", "disk", "", True),
        ("stat", "disk", "", False),
        ("truncate", "disk", "", True),
        ("unlink", "disk", "", True),
        ("write", "disk", "", True),
    ],
    "email": [
        ("read", "email", "", False),
        ("readdir", "email", "", False),
        ("stat", "email", "", False),
    ],
    "gdocs": [
        ("read", "gdocs", ".gdoc.json", False),
        ("read", "gdrive", ".gdoc.json", False),
        ("readdir", "gdocs", "", False),
        ("stat", "gdocs", "", False),
    ],
    "gdrive": [
        ("read", "gdrive", "", False),
        ("read", "gdrive", ".feather", False),
        ("read", "gdrive", ".hdf5", False),
        ("read", "gdrive", ".orc", False),
        ("read", "gdrive", ".parquet", False),
        ("readdir", "gdrive", "", False),
        ("stat", "gdrive", "", False),
    ],
    "github": [
        ("read", "github", "", False),
        ("readdir", "github", "", False),
        ("stat", "github", "", False),
    ],
    "github_ci": [
        ("read", "github_ci", "", False),
        ("readdir", "github_ci", "", False),
        ("stat", "github_ci", "", False),
    ],
    "gmail": [
        ("read", "gmail", "", False),
        ("readdir", "gmail", "", False),
        ("stat", "gmail", "", False),
    ],
    "gsheets": [
        ("read", "gdrive", ".gsheet.json", False),
        ("read", "gsheets", ".gsheet.json", False),
        ("readdir", "gsheets", "", False),
        ("stat", "gsheets", "", False),
    ],
    "gslides": [
        ("read", "gdrive", ".gslide.json", False),
        ("read", "gslides", ".gslide.json", False),
        ("readdir", "gslides", "", False),
        ("stat", "gslides", "", False),
    ],
    "hf_buckets": [
        ("create", "hf_buckets", "", True),
        ("create", "hf_datasets", "", True),
        ("create", "hf_models", "", True),
        ("create", "hf_spaces", "", True),
        ("mkdir", "hf_buckets", "", True),
        ("mkdir", "hf_datasets", "", True),
        ("mkdir", "hf_models", "", True),
        ("mkdir", "hf_spaces", "", True),
        ("read", "hf_buckets", "", False),
        ("read", "hf_buckets", ".feather", False),
        ("read", "hf_buckets", ".hdf5", False),
        ("read", "hf_buckets", ".orc", False),
        ("read", "hf_buckets", ".parquet", False),
        ("read", "hf_datasets", "", False),
        ("read", "hf_datasets", ".feather", False),
        ("read", "hf_datasets", ".hdf5", False),
        ("read", "hf_datasets", ".orc", False),
        ("read", "hf_datasets", ".parquet", False),
        ("read", "hf_models", "", False),
        ("read", "hf_models", ".feather", False),
        ("read", "hf_models", ".hdf5", False),
        ("read", "hf_models", ".orc", False),
        ("read", "hf_models", ".parquet", False),
        ("read", "hf_spaces", "", False),
        ("read", "hf_spaces", ".feather", False),
        ("read", "hf_spaces", ".hdf5", False),
        ("read", "hf_spaces", ".orc", False),
        ("read", "hf_spaces", ".parquet", False),
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
        ("read", "history", "", False),
        ("readdir", "history", "", False),
        ("stat", "history", "", False),
    ],
    "lancedb": [
        ("read", "lancedb", "", False),
        ("readdir", "lancedb", "", False),
        ("stat", "lancedb", "", False),
    ],
    "langfuse": [
        ("read", "langfuse", "", False),
        ("readdir", "langfuse", "", False),
        ("stat", "langfuse", "", False),
    ],
    "linear": [
        ("read", "linear", "", False),
        ("readdir", "linear", "", False),
        ("stat", "linear", "", False),
    ],
    "mongodb": [
        ("read", "mongodb", "", False),
        ("readdir", "mongodb", "", False),
        ("stat", "mongodb", "", False),
    ],
    "nextcloud": [
        ("create", "nextcloud", "", True),
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
        ("read", "notion", "", False),
        ("readdir", "notion", "", False),
        ("stat", "notion", "", False),
    ],
    "onedrive": [
        ("create", "onedrive", "", True),
        ("mkdir", "onedrive", "", True),
        ("read", "onedrive", "", False),
        ("read", "onedrive", ".feather", False),
        ("read", "onedrive", ".hdf5", False),
        ("read", "onedrive", ".orc", False),
        ("read", "onedrive", ".parquet", False),
        ("readdir", "onedrive", "", False),
        ("rename", "onedrive", "", True),
        ("rmdir", "onedrive", "", True),
        ("stat", "onedrive", "", False),
        ("truncate", "onedrive", "", True),
        ("unlink", "onedrive", "", True),
        ("write", "onedrive", "", True),
    ],
    "postgres": [
        ("read", "postgres", "", False),
        ("readdir", "postgres", "", False),
        ("stat", "postgres", "", False),
    ],
    "qdrant": [
        ("read", "qdrant", "", False),
        ("readdir", "qdrant", "", False),
        ("stat", "qdrant", "", False),
    ],
    "ram": [
        ("append", "ram", "", True),
        ("create", "ram", "", True),
        ("mkdir", "ram", "", True),
        ("read", "ram", "", False),
        ("read", "ram", ".feather", False),
        ("read", "ram", ".hdf5", False),
        ("read", "ram", ".orc", False),
        ("read", "ram", ".parquet", False),
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
        ("mkdir", "redis", "", True),
        ("read", "redis", "", False),
        ("read", "redis", ".feather", False),
        ("read", "redis", ".hdf5", False),
        ("read", "redis", ".orc", False),
        ("read", "redis", ".parquet", False),
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
        ("create", "s3", "", True),
        ("mkdir", "s3", "", True),
        ("read", "s3", "", False),
        ("read", "s3", ".feather", False),
        ("read", "s3", ".hdf5", False),
        ("read", "s3", ".orc", False),
        ("read", "s3", ".parquet", False),
        ("readdir", "s3", "", False),
        ("rename", "s3", "", True),
        ("rmdir", "s3", "", True),
        ("stat", "s3", "", False),
        ("truncate", "s3", "", True),
        ("unlink", "s3", "", True),
        ("write", "s3", "", True),
    ],
    "sharepoint": [
        ("create", "sharepoint", "", True),
        ("mkdir", "sharepoint", "", True),
        ("read", "sharepoint", "", False),
        ("read", "sharepoint", ".feather", False),
        ("read", "sharepoint", ".hdf5", False),
        ("read", "sharepoint", ".orc", False),
        ("read", "sharepoint", ".parquet", False),
        ("readdir", "sharepoint", "", False),
        ("rename", "sharepoint", "", True),
        ("rmdir", "sharepoint", "", True),
        ("stat", "sharepoint", "", False),
        ("truncate", "sharepoint", "", True),
        ("unlink", "sharepoint", "", True),
        ("write", "sharepoint", "", True),
    ],
    "slack": [
        ("read", "slack", "", False),
        ("readdir", "slack", "", False),
        ("stat", "slack", "", False),
    ],
    "ssh": [
        ("create", "ssh", "", True),
        ("mkdir", "ssh", "", True),
        ("read", "ssh", "", False),
        ("read", "ssh", ".feather", False),
        ("read", "ssh", ".hdf5", False),
        ("read", "ssh", ".orc", False),
        ("read", "ssh", ".parquet", False),
        ("readdir", "ssh", "", False),
        ("rename", "ssh", "", True),
        ("rmdir", "ssh", "", True),
        ("stat", "ssh", "", False),
        ("truncate", "ssh", "", True),
        ("unlink", "ssh", "", True),
        ("write", "ssh", "", True),
    ],
    "trello": [
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
            actual.add((ro.name, ro.resource, ro.filetype or "", ro.write))
    expected = {row for row in OPS_INVENTORY[backend] if _available(row[2])}
    assert actual == expected
