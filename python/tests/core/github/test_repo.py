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

import asyncio
from unittest.mock import patch

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.config import GhConfig, GitHubConfig
from mirage.core.github.repo import (create_repo, ensure_ref,
                                     fetch_default_branch, list_repos,
                                     parse_repo)


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
                                      repo="proj",
                                      session=None)


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


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
async def test_ensure_ref_resolves_the_default_branch_when_none_was_named(
        mock_get, config):
    mock_get.return_value = {"default_branch": "master"}
    accessor = GitHubAccessor(config, "acme", "proj")
    assert await ensure_ref(accessor) == "master"
    # Settled on the accessor, so the next reader neither refetches nor
    # disagrees with the ref this one read.
    assert accessor.ref == "master"


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
async def test_ensure_ref_keeps_a_pinned_ref_without_a_request(
        mock_get, config):
    accessor = GitHubAccessor(config, "acme", "proj", "release-2")
    assert await ensure_ref(accessor) == "release-2"
    mock_get.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("owner", "expected"), [("Alice", "/user/repos"),
                                                 ("acme", "/orgs/acme/repos")])
async def test_create_repo_distinguishes_the_user_from_an_org(
        monkeypatch, owner, expected):
    calls = []

    async def request(token, method, path, body=None, *, base_url=None):
        calls.append((method, path, body))
        return {"login": "alice"} if path == "/user" else {"name": "new"}

    monkeypatch.setitem(create_repo.__globals__, "github_request", request)
    body = {"name": "new"}

    assert await create_repo(GhConfig(token="t"), owner, body) == {
        "name": "new"
    }
    assert calls == [("GET", "/user", None), ("POST", expected, body)]


@pytest.mark.asyncio
@pytest.mark.parametrize(("kind", "expected"),
                         [("User", "/users/alice/repos"),
                          ("Organization", "/orgs/alice/repos")])
async def test_list_repos_resolves_the_owner_type(monkeypatch, kind, expected):
    calls = []

    async def request(token, method, path, *, base_url=None):
        return {"type": kind}

    async def pages(config, path, *, params, limit):
        calls.append((path, params, limit))
        return []

    monkeypatch.setitem(list_repos.__globals__, "github_request", request)
    monkeypatch.setitem(list_repos.__globals__, "github_pages", pages)

    assert await list_repos(GhConfig(token="t"), "alice", 5) == []
    assert calls == [(expected, {"sort": "pushed"}, 5)]


@pytest.mark.asyncio
@patch("mirage.core.github.repo.github_get")
async def test_ensure_ref_resolves_once_for_concurrent_readers(
        mock_get, config):
    mock_get.return_value = {"default_branch": "trunk"}
    accessor = GitHubAccessor(config, "acme", "proj")
    refs = await asyncio.gather(*(ensure_ref(accessor) for _ in range(4)))
    assert refs == ["trunk"] * 4
    assert mock_get.await_count == 1
