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
from pydantic import ValidationError

from mirage.vfs.registry import build_vfs
from mirage.vfs.tidb_filesystem.config import TiDBFilesystemConfig


def test_root_path_is_normalized():
    config = TiDBFilesystemConfig(
        host="https://aws-us-east-1.drive9.ai/",
        token="t",
        root_path="projects//a/",
    )

    assert config.root_path == "/projects/a"
    assert config.host == "https://aws-us-east-1.drive9.ai"


def test_root_path_refuses_dot_dot():
    with pytest.raises(ValidationError):
        TiDBFilesystemConfig(host="https://h", token="t", root_path="/a/..")


def test_unknown_key_is_refused():
    with pytest.raises(ValidationError):
        TiDBFilesystemConfig(host="https://h", token="t", region="x")


def test_built_by_name():
    vfs = build_vfs(
        "tidb_filesystem", {"host": "https://h", "token": "t", "timeout": 5}
    )

    assert vfs.config.timeout == 5
    assert vfs.config.token.get_secret_value() == "t"
