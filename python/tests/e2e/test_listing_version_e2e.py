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

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.github.conftest import TOKEN, GitHubRepo


async def _ls(ws: Workspace, repo: GitHubRepo, line: str):
    await repo.run.record_requests()
    result = await asyncio.wait_for(ws.shell(line), 10)
    out = await result.materialize_stdout()
    assert (result.exit_code, await result.stderr_str()) == (0, "")
    return out, await repo.counts()


# A fresh github mount lists the tree once, then pays one check of the head
# per command while nothing changes, and one check plus one walk after a
# change outside mirage.
@pytest.mark.asyncio
async def test_a_fresh_github_mount_checks_its_head_per_command(github_origin):
    repo = GitHubRepo(github_origin)
    try:
        await repo.create({"docs/a.txt": b"a\n", "docs/b.txt": b"b\n"})
        vfs = build_vfs(
            "github",
            {
                "token": TOKEN,
                "owner": repo.owner,
                "repo": repo.name,
                "ref": "main",
                "base_url": repo.run.url,
            },
        )
        ws = Workspace(
            {
                "/gh": Mount(
                    vfs=vfs,
                    mode=MountMode.READ,
                    read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
                )
            }
        )
        try:
            assert await _ls(ws, repo, "ls /gh/docs") == (
                b"a.txt\nb.txt\n",
                (0, 1, 0),
            )
            assert await _ls(ws, repo, "ls /gh/docs") == (
                b"a.txt\nb.txt\n",
                (1, 0, 0),
            )
            await repo.commit({"docs/c.txt": b"c\n"})
            assert await _ls(ws, repo, "ls /gh/docs") == (
                b"a.txt\nb.txt\nc.txt\n",
                (1, 1, 0),
            )
        finally:
            await ws.close()
    finally:
        await repo.run.close()
