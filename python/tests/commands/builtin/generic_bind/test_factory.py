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

from dataclasses import replace

import pytest

from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.generic_bind.factory import (
    GENERIC_COMMANDS,
    _run_builder,
    generic,
    with_slash_guard,
    with_stat_cache,
)
from mirage.commands.config import CommandIO, CommandOpts
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.workspace.files import Files


class _CountingBackend:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.stream_calls = 0
        self.bytes_calls = 0

    async def read_stream(self, accessor, path, *args, **kwargs):
        self.stream_calls += 1
        yield self.data

    async def read_bytes(self, accessor, path, *args, **kwargs) -> bytes:
        self.bytes_calls += 1
        return self.data


async def _noop_readdir(accessor, path, index=None) -> list[str]:
    return []


async def _noop_stat(accessor, path, index=None):
    return None


def _ops(backend: _CountingBackend) -> CommandIO:
    return CommandIO(
        readdir=_noop_readdir,
        read_bytes=backend.read_bytes,
        read_stream=backend.read_stream,
        stat=_noop_stat,
        is_mounted=lambda a: True,
    )


def _spec() -> PathSpec:
    return PathSpec(
        vfs_path=mount_key("/s3/a.txt", "/s3/"),
        virtual="/s3/a.txt",
        directory="/s3/",
    )


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


def test_the_generic_set_has_every_builder_whatever_the_backend_lacks():
    # A backend without the write-side ops still gets the whole family:
    # `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line that
    # writes is refused at the missing op instead of the command being
    # absent.
    assert {c.name for c in GENERIC_COMMANDS} == {b.name for b in BUILDERS}
    assert {c.vfs for c in GENERIC_COMMANDS} == {None}


def test_generic_hands_back_the_shared_command():
    assert generic("grep") is GENERIC_COMMANDS.require("grep")


def test_generic_with_a_table_registers_a_copy_for_one_backend():
    ls = generic("ls", vfs="dify", table=with_stat_cache)
    assert (ls.name, ls.vfs) == ("ls", "dify")
    assert ls is not generic("ls")
    assert ls.spec == generic("ls").spec


class _NoLinks:
    """An empty link table, as a workspace with no links holds."""

    def follow(self, path: str) -> str:
        return path

    def link_stat_at(self, path: str) -> None:
        return None

    def link_stats_below(self, directory: str) -> list:
        return []

    def symlink_targets(self) -> dict[str, str]:
        return {}


async def _nothing(op: str, path: PathSpec, **_):
    return None, None


@pytest.mark.asyncio
async def test_namespace_globs_stamp_the_link_target_stat():
    # The command tier's `*/` asks the namespace what a link points at,
    # so the invocation's target_stat rides the adapter, stamped per
    # invocation. The listing already names the namespace's children.
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    opts = CommandOpts(vfs=Files([], _nothing, links=_NoLinks()))
    await _run_builder(
        lambda ops: ops,
        capture,
        None,
        None,
        [],
        [],
        replace(opts, io=_ops(_CountingBackend(b""))),
    )
    assert seen[0].glob_target_stat is not None


@pytest.mark.asyncio
async def test_namespace_globs_stamp_nothing_without_links():
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    opts = CommandOpts(vfs=Files([], _nothing))
    await _run_builder(
        lambda ops: ops,
        capture,
        None,
        None,
        [],
        [],
        replace(opts, io=_ops(_CountingBackend(b""))),
    )
    assert seen[0].glob_target_stat is None


@pytest.mark.asyncio
async def test_slash_guard_refuses_a_slashed_write_before_the_backend():
    # open(2) with O_CREAT answers `x/` with EISDIR before looking anything
    # up, so `tee missing/` and `truncate -s0 missing/` must not leave a
    # regular file called `missing` behind; a bare operand passes through.
    backend = _CountingBackend(b"")
    written: list[str] = []

    async def write(accessor, path, data) -> None:
        written.append(path.virtual)

    async def truncate(accessor, path, length) -> None:
        written.append(path.virtual)

    guarded = with_slash_guard(
        replace(_ops(backend), write=write, append=write, truncate=truncate)
    )
    slashed = PathSpec(
        vfs_path=mount_key("/s3/missing", "/s3/"),
        virtual="/s3/missing",
        directory="/s3/",
        raw_path="/s3/missing/",
    )
    with pytest.raises(IsADirectoryError):
        await guarded.write(None, slashed, b"x")
    with pytest.raises(IsADirectoryError):
        await guarded.append(None, slashed, b"x")
    with pytest.raises(IsADirectoryError):
        await guarded.truncate(None, slashed, 0)
    await guarded.write(None, _spec(), b"x")
    await guarded.truncate(None, _spec(), 0)
    assert written == ["/s3/a.txt", "/s3/a.txt"]


@pytest.mark.asyncio
async def test_slash_guard_leaves_write_absent_when_the_backend_has_none():
    guarded = with_slash_guard(_ops(_CountingBackend(b"")))
    assert guarded.write is None
    assert guarded.append is None
    assert guarded.truncate is None


@pytest.mark.parametrize("table", [None, with_stat_cache])
def test_a_name_no_builder_has_is_refused(table):
    with pytest.raises(ValueError, match="no generic command named 'lss'"):
        generic("lss", vfs="fake", table=table)
