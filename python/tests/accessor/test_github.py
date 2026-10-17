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
