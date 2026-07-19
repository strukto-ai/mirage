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

from mirage.resource.dropbox import DropboxConfig, DropboxResource
from mirage.resource.registry import build_resource


def make_resource(**overrides) -> DropboxResource:
    return DropboxResource(
        DropboxConfig(client_id="c",
                      client_secret="sekret",
                      refresh_token="refresh-sekret",
                      **overrides))


def test_registers_read_write_op_surface():
    resource = make_resource()
    ops = {(o.name, o.write) for o in resource.ops_list()}
    assert ops == {
        ("read", False),
        ("readdir", False),
        ("stat", False),
        ("write", True),
        ("create", True),
        ("mkdir", True),
        ("unlink", True),
        ("rmdir", True),
        ("rename", True),
        ("truncate", True),
    }


def test_subfolder_root_reaches_accessor():
    resource = make_resource(root_path="Team/data/")
    assert resource.accessor.root_path == "/Team/data"


def test_state_does_not_leak_secrets():
    state = make_resource().get_state()
    dumped = json.dumps(state, default=str)
    assert "sekret" not in dumped


def test_registry_builds_dropbox():
    resource = build_resource(
        "dropbox", {
            "client_id": "c",
            "client_secret": "s",
            "refresh_token": "r",
            "root_path": "/Team",
        })
    assert isinstance(resource, DropboxResource)
    assert resource.accessor.root_path == "/Team"


def test_invalid_root_path_rejected():
    with pytest.raises(ValueError, match="'\\.\\.'"):
        make_resource(root_path="/a/../b")
