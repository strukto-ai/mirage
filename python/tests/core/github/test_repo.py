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
from mirage.core.github.repo import fetch_default_branch, parse_repo


@pytest.fixture
def config():
    return GitHubConfig(token="ghp_test")


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
async def test_fetch_default_branch_main(mock_get, config):
    mock_get.return_value = {"default_branch": "main"}
    result = await fetch_default_branch(config, "acme", "proj")
    assert result == "main"
    mock_get.assert_awaited_once_with(config.token,
                                      "/repos/{owner}/{repo}",
                                      base_url=None,
                                      owner="acme",
                                      repo="proj")


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
async def test_fetch_default_branch_master(mock_get, config):
    mock_get.return_value = {"default_branch": "master"}
    result = await fetch_default_branch(config, "acme", "proj")
    assert result == "master"


# gh's format is [HOST/]OWNER/REPO, so the owner and repository are always the
# last two segments. Taking the first two read `github.com/acme/tools` as
# owner `github.com`, repo `acme` -- a different repository, reported as
# success rather than as an error.
def test_parse_repo_takes_owner_and_repo():
    ref = parse_repo("acme/tools")
    assert (ref.owner, ref.repo) == ("acme", "tools")


def test_parse_repo_drops_the_optional_host():
    ref = parse_repo("github.com/acme/tools")
    assert (ref.owner, ref.repo) == ("acme", "tools")


@pytest.mark.parametrize("spec", ["justaname", "a/b/c/d", "acme/", "/tools"])
def test_parse_repo_refuses_a_spec_that_is_not_the_format(spec):
    with pytest.raises(ValueError, match="OWNER/REPO"):
        parse_repo(spec)
