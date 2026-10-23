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

from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git import GIT
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import MOUNT, commit_file, run

STOPPED = (
    b"fatal: stopped after 2 files (full_scan_limit); narrow the pathspec\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, answer",
    [
        ("grep -e e", (128, b"a.txt:one changed\n", STOPPED)),
        ("grep --cached -e e", (128, b"a.txt:one changed\n", STOPPED)),
        ("grep -e e -- c.txt", (0, b"c.txt:three\n", b"")),
        ("grep -q -e one", (0, b"", b"")),
    ],
)
async def test_a_search_past_the_full_scan_limit_stops_with_a_fatal(
    repo_path: Path, line: str, answer: tuple[int, bytes, bytes]
):
    commit_file(repo_path, "c.txt", "three\n", "fourth")
    vfs = DiskVFS(root=str(repo_path), full_scan_limit=2)
    with Workspace({MOUNT: vfs}) as ws:
        ws.register_cli("git", GIT)
        assert await run(ws, line) == answer


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flag, answer",
    [
        ("", ("a.txt:one\n128\n", STOPPED.decode())),
        ("--cached ", ("a.txt:one\nc.txt:three\n0\n", "")),
    ],
)
async def test_a_work_tree_counts_against_the_mount_serving_it(
    flag: str, answer: tuple[str, str]
):
    with Workspace(
        {
            "/meta/": RAMVFS(full_scan_limit=-1),
            "/data/": RAMVFS(full_scan_limit=2),
        },
        mode=MountMode.WRITE,
    ) as ws:
        ws.register_cli("git", GIT)
        git = "git --git-dir=/meta/.git --work-tree=/data"
        await ws.shell(
            "git init -q /meta && echo one > /data/a.txt && "
            "echo two > /data/b.txt && echo three > /data/c.txt && "
            f"{git} add a.txt b.txt c.txt"
        )
        result = await ws.shell(f"{git} grep {flag}-e e; echo $?")
        assert (await result.stdout_str(), await result.stderr_str()) == answer
