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
import importlib
import os
import subprocess
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.pack import store_pack
from mirage.types import MountMode, PathSpec
from mirage.utils.ids import SystemIdSource
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ENV = {
    **os.environ,
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "A",
    "GIT_AUTHOR_EMAIL": "a@example.com",
    "GIT_COMMITTER_NAME": "A",
    "GIT_COMMITTER_EMAIL": "a@example.com",
}
GITDIR = PathSpec.from_str_path("/r/.git")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        env=ENV,
        check=True,
        capture_output=True,
        text=True,
    ).stdout


async def _chunked(data: bytes, size: int) -> AsyncGenerator[bytes, None]:
    for at in range(0, len(data), size):
        await asyncio.sleep(0)
        yield data[at : at + size]


@pytest.fixture(scope="module")
def packed(tmp_path_factory) -> tuple[Path, str, bytes, bytes]:
    """A real git repository repacked into one pack with deltas.

    Args:
        tmp_path_factory (TempPathFactory): pytest's module temp dirs.
    """
    root = tmp_path_factory.mktemp("pack")
    _git(root, "init", "-q", "-b", "main")
    lines = [f"line {n} of a file long enough to delta" for n in range(400)]
    for round_ in range(6):
        lines[round_ * 50] = f"changed in round {round_}"
        (root / "big.txt").write_text("\n".join(lines) + "\n")
        (root / f"small{round_}.txt").write_text(f"{round_}\n")
        _git(root, "add", "-A")
        _git(root, "commit", "-q", "-m", f"round {round_}")
    _git(root, "repack", "-a", "-d", "-f", "-q", "--depth=50", "--window=10")
    directory = root / ".git" / "objects" / "pack"
    name = next(p.name for p in directory.iterdir() if p.suffix == ".pack")
    stem = name.removesuffix(".pack")
    return (
        root,
        stem,
        (directory / name).read_bytes(),
        (directory / f"{stem}.idx").read_bytes(),
    )


@pytest.fixture
def files():
    """A writable session's files over RAM."""
    with Workspace({"/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        yield ws.vfs


@pytest.mark.asyncio
async def test_the_pack_is_kept_with_the_index_git_writes(packed, files):
    root, stem, pack, idx = packed
    directory = root / ".git" / "objects" / "pack"
    verify = _git(root, "verify-pack", "-v", str(directory / f"{stem}.idx"))
    assert "chain length = " in verify
    await store_pack(files, GITDIR, _chunked(pack, 997), SystemIdSource())
    out = GITDIR.join("objects/pack")
    names = sorted(p.rsplit("/", 1)[-1] for p in await files.readdir(out))
    assert names == [f"{stem}.idx", f"{stem}.pack"]
    assert await files.read(out.join(f"{stem}.pack")) == pack
    assert await files.read(out.join(f"{stem}.idx")) == idx


@pytest.mark.asyncio
async def test_a_corrupt_pack_is_refused_as_git_does_leaving_nothing(
    packed, files
):
    _, _, pack, _ = packed
    bad = pack[:-1] + bytes([pack[-1] ^ 1])
    with pytest.raises(GitError, match=r"pack is corrupted \(SHA1 mismatch\)"):
        await store_pack(files, GITDIR, _chunked(bad, 4096), SystemIdSource())
    assert await files.readdir(GITDIR.join("objects/pack")) == []
    with pytest.raises(GitError, match="early EOF"):
        await store_pack(
            files, GITDIR, _chunked(pack[:100], 30), SystemIdSource()
        )
    assert await files.readdir(GITDIR.join("objects/pack")) == []


@pytest.mark.asyncio
async def test_an_empty_pack_stores_nothing(files):
    await store_pack(files, GITDIR, _chunked(b"", 1), SystemIdSource())
    assert not await files.exists(GITDIR.join("objects/pack"))


@pytest.mark.asyncio
async def test_a_cancelled_store_leaves_nothing_behind(
    packed, files, monkeypatch
):
    _, _, pack, _ = packed

    async def cut() -> AsyncGenerator[bytes, None]:
        yield pack[:4096]
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await store_pack(files, GITDIR, cut(), SystemIdSource())
    assert await files.readdir(GITDIR.join("objects/pack")) == []

    async def cancelled(*_args) -> dict[int, bytes]:
        raise asyncio.CancelledError

    monkeypatch.setattr(
        importlib.import_module("mirage.commands.cli.builtin.git.pack"),
        "delta_ids",
        cancelled,
    )
    with pytest.raises(asyncio.CancelledError):
        await store_pack(files, GITDIR, _chunked(pack, 997), SystemIdSource())
    assert await files.readdir(GITDIR.join("objects/pack")) == []
