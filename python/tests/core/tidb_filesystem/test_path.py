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

from mirage.core.tidb_filesystem.path import backend_path
from mirage.vfs.tidb_filesystem.config import TiDBFilesystemConfig


def _config(root: str) -> TiDBFilesystemConfig:
    return TiDBFilesystemConfig(
        host="http://drive9", token="t", root_path=root
    )


@pytest.mark.parametrize(
    ("root", "path", "expected"),
    [
        ("/", "/", "/"),
        ("/", "/a/b", "/a/b"),
        ("/proj", "/", "/proj"),
        ("/proj", "/a/./b/", "/proj/a/b"),
    ],
)
def test_backend_path_joins_the_root(root, path, expected):
    assert backend_path(_config(root), path) == expected


def test_backend_path_refuses_an_escape():
    with pytest.raises(ValueError):
        backend_path(_config("/proj"), "/../x")
