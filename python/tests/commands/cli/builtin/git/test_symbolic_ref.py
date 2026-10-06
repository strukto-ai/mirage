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


async def run(ws, line: str) -> tuple[int, str, str]:
    result = await ws.shell(f"git -C /repo {line}")
    return (
        result.exit_code,
        (result.stdout or b"").decode(),
        (result.stderr or b"").decode(),
    )


def log_lines(repo_path: Path, *parts: str) -> list[bytes]:
    path = repo_path.joinpath(".git", "logs", *parts)
    return path.read_bytes().splitlines() if path.exists() else []


@pytest.mark.asyncio
async def test_logs_a_move_as_git_does(git_rw, repo_path: Path):
    await run(git_rw, "branch other")
    before = log_lines(repo_path, "HEAD")
    await run(git_rw, "symbolic-ref HEAD refs/heads/other")
    moved = log_lines(repo_path, "HEAD")
    assert len(moved) == len(before) + 1
    assert b"\t" not in moved[-1]
    await run(git_rw, "symbolic-ref HEAD refs/heads/unborn")
    assert log_lines(repo_path, "HEAD") == moved
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    await run(git_rw, "symbolic-ref refs/other refs/heads/main")
    assert log_lines(repo_path, "refs", "heads", "sym")[0].startswith(
        b"0" * 40
    )
    assert log_lines(repo_path, "refs", "other") == []


@pytest.mark.asyncio
async def test_log_all_ref_updates_decides_which_refs_are_logged(
    git_rw, repo_path: Path
):
    config = repo_path / ".git/config"
    config.write_text(
        config.read_text() + "[core]\n\tlogAllRefUpdates = always\n"
    )
    await run(git_rw, "symbolic-ref refs/other refs/heads/main")
    assert len(log_lines(repo_path, "refs", "other")) == 1
    config.write_text(
        config.read_text() + "[core]\n\tlogAllRefUpdates = false\n"
    )
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    assert log_lines(repo_path, "refs", "heads", "sym") == []


@pytest.mark.asyncio
async def test_delete_removes_the_log_and_a_cycle_is_no_such_ref(
    git_rw, repo_path: Path
):
    head = (repo_path / ".git/refs/heads/main").read_text().strip()
    with (repo_path / ".git/packed-refs").open("a") as packed:
        packed.write(f"{head} refs/heads/sym\n")
    await run(git_rw, "symbolic-ref refs/heads/sym refs/heads/main")
    assert await run(git_rw, "symbolic-ref -d refs/heads/sym") == (0, "", "")
    assert not (repo_path / ".git/logs/refs/heads/sym").exists()
    assert (await run(git_rw, "rev-parse -q --verify refs/heads/sym"))[0] == 1
    await run(git_rw, "symbolic-ref CYCLE_A CYCLE_B")
    await run(git_rw, "symbolic-ref CYCLE_B CYCLE_A")
    assert await run(git_rw, "symbolic-ref CYCLE_A") == (
        128,
        "",
        "fatal: No such ref: CYCLE_A\n",
    )
