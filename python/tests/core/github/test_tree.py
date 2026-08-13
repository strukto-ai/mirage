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
from mirage.core.github.tree import fetch_dir_tree, fetch_tree
from mirage.core.github.tree_entry import TreeEntry


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_parses_entries(mock_get, config):
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
    tree, truncated = await fetch_tree(config, "acme", "proj", "main")
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


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "truncated":
        False,
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ],
    }
    tree, _ = await fetch_tree(config, "acme", "proj", "main")
    assert "extern" not in tree
    assert list(tree) == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_dir_tree_excludes_submodule_gitlinks(mock_get, config):
    mock_get.return_value = {
        "tree": [
            {
                "path": "extern",
                "mode": "160000",
                "type": "commit",
                "sha": "ccc"
            },
            {
                "path": "main.py",
                "type": "blob",
                "sha": "bbb",
                "size": 7
            },
        ]
    }
    entries = await fetch_dir_tree(config, "acme", "proj", "sha1")
    assert [e.path for e in entries] == ["main.py"]


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_truncation_warning(mock_get, config, caplog):
    mock_get.return_value = {"truncated": True, "tree": []}
    with caplog.at_level(logging.WARNING):
        await fetch_tree(config, "acme", "proj", "main")
    assert "truncated" in caplog.text


@pytest.mark.asyncio
@patch("mirage.core.github.tree.github_get")
async def test_fetch_tree_passes_params(mock_get, config):
    mock_get.return_value = {"tree": []}
    await fetch_tree(config, "acme", "proj", "v1")
    mock_get.assert_awaited_once_with(
        config.token,
        "/repos/{owner}/{repo}/git/trees/{ref}",
        params={"recursive": "1"},
        base_url=None,
        owner="acme",
        repo="proj",
        ref="v1",
    )
