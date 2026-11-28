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

import pytest

from mirage.accessor.github import GitHubAccessor
from mirage.core.github.repo import (
    ensure_ref,
    fetch_default_branch,
    parse_repo,
)


@pytest.mark.asyncio
async def test_fetch_default_branch_main(repo):
    await repo.create({"a.txt": b"a"})
    account = repo.accessor().account
    result = await fetch_default_branch(account, repo.owner, repo.name)
    assert result == "main"
    assert await repo.log() == [("repo", "")]


@pytest.mark.asyncio
async def test_fetch_default_branch_master(repo):
    await repo.create({"a.txt": b"a"})
    await repo.branch("master")
    await repo.set_default_branch("master")
    account = repo.accessor().account
    result = await fetch_default_branch(account, repo.owner, repo.name)
    assert result == "master"


# gh's format is [HOST/]OWNER/REPO, so the owner and repository are always the
# last two segments. Taking the first two read `github.com/acme/tools` as
# owner `github.com`, repo `acme` -- a different repository, reported as
# success rather than as an error.
@pytest.mark.parametrize(
    "spec",
    [
        "acme/tools",
        "github.com/acme/tools",
        "http://github.com/acme/tools/",
        "git://github.com/acme/tools",
    ],
)
def test_parse_repo_takes_owner_and_repo(spec):
    ref = parse_repo(spec)
    assert (ref.owner, ref.repo) == ("acme", "tools")


@pytest.mark.parametrize(
    ("spec", "message"),
    [
        ("justaname", "OWNER/REPO"),
        ("a/b/c/d", "OWNER/REPO"),
        ("acme/", "OWNER/REPO"),
        ("/tools", "OWNER/REPO"),
        ("/acme/tools", "OWNER/REPO"),
        ("https://github.com/a/b/c", "invalid path: /a/b/c"),
        ("https:///acme/tools", "no hostname detected"),
    ],
)
def test_parse_repo_refuses_a_spec_that_is_not_the_format(spec, message):
    with pytest.raises(ValueError, match=message):
        parse_repo(spec)


@pytest.mark.asyncio
async def test_ensure_ref_resolves_the_default_branch_when_none_was_named(
    repo,
):
    await repo.create({"a.txt": b"a"})
    await repo.branch("master")
    await repo.set_default_branch("master")
    accessor = GitHubAccessor(repo.accessor().account, repo.owner, repo.name)
    assert await ensure_ref(accessor) == "master"
    # Settled on the accessor, so the next reader neither refetches nor
    # disagrees with the ref this one read.
    assert accessor.ref == "master"


@pytest.mark.asyncio
async def test_ensure_ref_keeps_a_pinned_ref_without_a_request(repo):
    await repo.create({"a.txt": b"a"})
    assert await ensure_ref(repo.accessor("release-2")) == "release-2"
    assert await repo.log() == []


@pytest.mark.asyncio
async def test_ensure_ref_resolves_once_for_concurrent_readers(repo):
    await repo.create({"a.txt": b"a"})
    await repo.branch("trunk")
    await repo.set_default_branch("trunk")
    accessor = GitHubAccessor(repo.accessor().account, repo.owner, repo.name)
    refs = await asyncio.gather(*(ensure_ref(accessor) for _ in range(4)))
    assert refs == ["trunk"] * 4
    assert await repo.count("repo") == 1
