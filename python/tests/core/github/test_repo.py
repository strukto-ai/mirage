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

from unittest.mock import patch

import pytest

from mirage.core.github.config import GitHubConfig
from mirage.core.github.repo import fetch_default_branch_sync


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@patch("mirage.core.github.repo.github_get_sync")
def test_fetch_default_branch_main(mock_get, config):
    mock_get.return_value = {"default_branch": "main"}
    result = fetch_default_branch_sync(config, "acme", "proj")
    assert result == "main"
    mock_get.assert_called_once_with(config.token,
                                     "/repos/{owner}/{repo}",
                                     owner="acme",
                                     repo="proj")


@patch("mirage.core.github.repo.github_get_sync")
def test_fetch_default_branch_master(mock_get, config):
    mock_get.return_value = {"default_branch": "master"}
    result = fetch_default_branch_sync(config, "acme", "proj")
    assert result == "master"
