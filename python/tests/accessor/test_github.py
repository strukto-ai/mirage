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

from mirage import Workspace
from mirage.commands.cli.builtin.gh import GH
from mirage.vfs.github import GitHubConfig, GitHubVFS
from mirage.vfs.ram import RAMVFS


@pytest.mark.asyncio
async def test_a_gh_install_rides_the_github_mounts_pool_on_one_token():
    vfs = GitHubVFS(GitHubConfig(token="t", owner="o", repo="r"))
    ws = Workspace({"/gh": vfs})
    pool = vfs.accessor.account.pool
    assert ws.register_cli("gh", GH, {"token": "t"}).accessor.pool is pool
    assert ws.register_cli("w", GH, {"token": "u"}).accessor.pool is not pool
    session = pool.get()
    await ws.unregister_cli("gh")
    assert not session.closed
    await ws.close()
    assert session.closed


@pytest.mark.asyncio
async def test_a_gh_write_reaches_github_mounts_on_its_api_base_alone():
    # Whatever token a mount reads with: two tokens can reach one
    # repository, so narrowing by token would leave a mount stale.
    mine = GitHubVFS(GitHubConfig(token="t", owner="o", repo="r"))
    theirs = GitHubVFS(GitHubConfig(token="u", owner="o", repo="r"))
    elsewhere = GitHubVFS(
        GitHubConfig(
            token="t", owner="o", repo="r", base_url="https://ghe.test/api"
        )
    )
    ram = RAMVFS()
    ws = Workspace(
        {"/gh": mine, "/theirs": theirs, "/ghe": elsewhere, "/ram": ram}
    )
    gh = ws.register_cli("gh", GH, {"token": "t"}).accessor
    assert gh.reaches(mine.accessor) and gh.reaches(theirs.accessor)
    assert not gh.reaches(elsewhere.accessor)
    assert not gh.reaches(ram.accessor)
    await ws.close()


@pytest.mark.asyncio
async def test_an_explicit_github_api_base_is_the_default_one():
    # A gh install naming github.com's API reaches, and shares with, a
    # mount that leaves the base unset: both call the same API.
    vfs = GitHubVFS(GitHubConfig(token="t", owner="o", repo="r"))
    ws = Workspace({"/gh": vfs})
    gh = ws.register_cli(
        "gh", GH, {"token": "t", "base_url": "https://api.github.com/"}
    ).accessor
    assert gh.reaches(vfs.accessor)
    assert gh.pool is vfs.accessor.account.pool
    await ws.close()
