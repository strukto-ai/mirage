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

import json

import pytest

from mirage.vfs.dropbox import DropboxConfig, DropboxVFS
from mirage.vfs.registry import build_vfs


def make_vfs(**overrides) -> DropboxVFS:
    return DropboxVFS(
        DropboxConfig(client_id="c",
                      client_secret="sekret",
                      refresh_token="refresh-sekret",
                      **overrides))


def test_registers_read_write_op_surface():
    vfs = make_vfs()
    ops = {(o.name, o.write) for o in vfs.ops_list()}
    assert ops == {
        ("read", False),
        ("readdir", False),
        ("stat", False),
        ("write", True),
        ("append", True),
        ("create", True),
        ("mkdir", True),
        ("unlink", True),
        ("rmdir", True),
        ("rename", True),
        ("truncate", True),
    }


def test_subfolder_root_reaches_accessor():
    vfs = make_vfs(root_path="Team/data/")
    assert vfs.accessor.root_path == "/Team/data"


def test_state_does_not_leak_secrets():
    state = make_vfs().get_state()
    dumped = json.dumps(state, default=str)
    assert "sekret" not in dumped


@pytest.mark.asyncio
async def test_registry_builds_dropbox():
    vfs = build_vfs(
        "dropbox", {
            "client_id": "c",
            "client_secret": "s",
            "refresh_token": "r",
            "root_path": "/Team",
        })
    assert isinstance(vfs, DropboxVFS)
    assert vfs.accessor.root_path == "/Team"


def test_invalid_root_path_rejected():
    with pytest.raises(ValueError, match="'\\.\\.'"):
        make_vfs(root_path="/a/../b")
