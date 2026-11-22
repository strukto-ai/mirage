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

import subprocess
from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git.embedded import (
    embedded_head,
    embedded_location,
)
from mirage.types import PathSpec
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace


def _repo(path: Path) -> str:
    """A repository at ``path`` with one commit; that commit."""
    path.mkdir(parents=True)
    git = ["git", "-C", str(path), "-c", "user.name=a", "-c", "user.email=a@b"]
    subprocess.run([*git, "init", "-q"], check=True)
    (path / "f").write_text("f\n", encoding="utf-8")
    subprocess.run([*git, "add", "."], check=True)
    subprocess.run([*git, "commit", "-qm", "f"], check=True)
    return subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.mark.asyncio
async def test_a_repository_is_found_and_its_head_followed(tmp_path: Path):
    head = _repo(tmp_path / "sub")
    # HEAD on a branch that is itself a symbolic ref to the one committed.
    branch = subprocess.run(
        ["git", "-C", str(tmp_path / "sub"), "symbolic-ref", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    (tmp_path / "sub" / ".git" / "refs" / "heads" / "alias").write_text(
        f"ref: {branch}\n", encoding="utf-8"
    )
    (tmp_path / "sub" / ".git" / "HEAD").write_text(
        "ref: refs/heads/alias\n", encoding="utf-8"
    )
    with Workspace({"/w": DiskVFS(root=str(tmp_path))}) as ws:
        location = await embedded_location(
            ws.vfs, PathSpec.from_str_path("/w/sub")
        )
        assert location is not None
        assert await embedded_head(ws.vfs, location) == head


@pytest.mark.asyncio
async def test_a_dot_git_that_is_no_repository_is_none(tmp_path: Path):
    (tmp_path / "lib" / ".git").mkdir(parents=True)
    (tmp_path / "lib" / ".git" / "HEAD").write_text(
        "ref: refs/heads/main\n", encoding="utf-8"
    )
    with Workspace({"/w": DiskVFS(root=str(tmp_path))}) as ws:
        assert (
            await embedded_location(ws.vfs, PathSpec.from_str_path("/w/lib"))
            is None
        )
