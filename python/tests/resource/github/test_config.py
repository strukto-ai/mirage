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

from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree_entry import TreeEntry
from mirage.resource.secrets import reveal_secret


def test_github_config_requires_token():
    with pytest.raises(ValidationError):
        GitHubConfig()


def test_github_config_with_token():
    cfg = GitHubConfig(token="ghp_abc123")
    assert reveal_secret(cfg.token) == "ghp_abc123"


def test_tree_entry_fields():
    entry = TreeEntry(path="src/main.py", type="blob", sha="abc123", size=1024)
    assert entry.path == "src/main.py"
    assert entry.type == "blob"
    assert entry.sha == "abc123"
    assert entry.size == 1024


def test_tree_entry_size_none():
    entry = TreeEntry(path="src", type="tree", sha="def456", size=None)
    assert entry.size is None
