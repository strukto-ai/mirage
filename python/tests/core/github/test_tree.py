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

import logging
from unittest.mock import patch

import pytest

from mirage.core.github.config import GitHubConfig
from mirage.core.github.tree import fetch_tree_sync
from mirage.core.github.tree_entry import TreeEntry


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@patch("mirage.core.github.tree.github_get_sync")
def test_fetch_tree_parses_entries(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "src",
                "type": "tree",
                "sha": "aaa",
                "size": None
            },
            {
                "path": "src/main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 120
            },
        ],
    }
    tree, truncated = fetch_tree_sync(config, "acme", "proj", "main")
    assert "src" in tree
    assert "src/main.py" in tree
    assert tree["src"] == TreeEntry(path="src",
                                    type="tree",
                                    sha="aaa",
                                    size=None)
    assert tree["src/main.py"] == TreeEntry(path="src/main.py",
                                            type="blob",
                                            sha="bbb",
                                            size=120)


@patch("mirage.core.github.tree.github_get_sync")
def test_fetch_tree_truncation_warning(mock_get, config, caplog):
    mock_get.return_value = {"truncated": True, "tree": []}
    with caplog.at_level(logging.WARNING):
        fetch_tree_sync(config, "acme", "proj", "main")
    assert "truncated" in caplog.text


@patch("mirage.core.github.tree.github_get_sync")
def test_fetch_tree_passes_params(mock_get, config):
    mock_get.return_value = {"tree": []}
    fetch_tree_sync(config, "acme", "proj", "v1")
    mock_get.assert_called_once_with(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        owner="acme",
        repo="proj",
        ref="v1",
        params={"recursive": "1"},
    )
