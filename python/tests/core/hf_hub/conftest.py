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

from mirage.accessor.hf_hub import HfHubAccessor, HfRepoConfig
from mirage.core.api.client import ApiResponse
from mirage.core.hf_hub.tree import parse_entry
from mirage.types import PathSpec


class FakeAccessor(HfHubAccessor):
    REPO_TYPE = "model"
    VFS_NAME = "hf_models"


@pytest.fixture
def accessor():
    return FakeAccessor(HfRepoConfig(repo_id="acme/widget"))


@pytest.fixture
def prefixed():
    return FakeAccessor(
        HfRepoConfig(repo_id="acme/widget", key_prefix="sub/dir"))


@pytest.fixture
def loaded(accessor):
    """An accessor whose listing is already hydrated, so no request runs."""
    seed(accessor, file_row("a.txt", 7), file_row("d/b.txt", 3), dir_row("d"))
    return accessor


def seed(accessor, *rows) -> None:
    accessor.tree = {r["path"]: parse_entry(r) for r in rows}
    accessor.tree_loaded = True
    accessor.rows_cache = None


def ps(path: str, prefix: str = "") -> PathSpec:
    """A PathSpec for a mount-local path under an optional mount prefix."""
    rel = path.strip("/")
    stem = prefix.rstrip("/")
    virtual = (f"{stem}/{rel}" if rel else stem) if stem else \
        (f"/{rel}" if rel else "/")
    parent = virtual.rsplit("/", 1)[0] or "/"
    return PathSpec(virtual=virtual,
                    directory=parent,
                    vfs_path=rel,
                    raw_path=virtual)


def page(rows, next_url: str = "") -> ApiResponse:
    """One tree page, with the Link header the cursor rides in."""
    headers = {"link": f'<{next_url}>; rel="next"'} if next_url else {}
    return ApiResponse(rows, 200, headers)


def file_row(path: str, size: int = 10, **extra) -> dict:
    return {
        "type": "file",
        "oid": f"oid-{path}",
        "size": size,
        "path": path,
        **extra
    }


def dir_row(path: str) -> dict:
    return {
        "type": "directory",
        "oid": f"tree-{path}",
        "size": 0,
        "path": path
    }
