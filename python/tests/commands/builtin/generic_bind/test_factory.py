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

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic_bind.builders import BUILDERS
from mirage.commands.builtin.generic_bind.factory import (
    _run_with_namespace_globs,
    generic_commands,
    scan_io,
    walked,
    with_probe_answers,
    with_slash_guard,
    with_stat_cache,
)
from mirage.commands.config import CommandIO, CommandOpts
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.types import DuOps
from mirage.view.types import LinkView, NamespaceView


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
        local=False,
    )


def _spec() -> PathSpec:
    return PathSpec(
        vfs_path=mount_key("/s3/a.txt", "/s3/"),
        virtual="/s3/a.txt",
        directory="/s3/",
    )


def _same_table(io: CommandIO) -> CommandIO:
    return io


async def _drain(source) -> bytes:
    return b"".join([c async for c in source])


def test_factory_registers_every_command_whatever_the_backend_lacks():
    # A backend without the write-side ops still gets the whole family:
    # `gzip -c`, `tar -t` and `split -n 1/2` only read, and a line that
    # writes is refused at the missing op instead of the command being
    # absent.
    _CountingBackend(b"payload")
    commands = generic_commands("limited")
    names = {
        registered.name
        for command in commands
        for registered in command._registered_commands
    }

    assert names == {b.name for b in BUILDERS}


def test_scan_io_guards_only_a_judged_mount():
    # A bespoke search scans the raw adapter when nothing on its mount is
    # hidden or refused, and the guarded one when anything is, since the
    # service's own search can answer for more than the operand.
    io = _ops(_CountingBackend(b"payload"))
    free = NamespaceView(scoped=lambda _virtual: False)
    judged = NamespaceView(scoped=lambda virtual: virtual == "/s3")
    for ns in (free, None):
        scan, scoped = scan_io(io, ns, "/s3/")
        assert scan is io and not scoped
    scan, scoped = scan_io(io, judged, "/s3/")
    assert scan is not io and scoped


async def _native(*args, **kwargs):
    return None


def test_walked_sets_the_native_find_and_du_aside():
    io = replace(
        _ops(_CountingBackend(b"payload")),
        find=_native,
        du=DuOps(size=_native, entries=_native),
    )
    rest = walked(io)
    assert rest.find is None and rest.du is None
    assert rest.readdir is io.readdir and rest.stat is io.stat


async def _no_target(virtual: str):
    return None


async def _nothing_there(virtual: str) -> bool:
    return False


def _no_links(directory: str) -> list:
    return []


def _same(path: str) -> str:
    return path


def _owes_nothing(parent: str) -> list[str]:
    return []


@pytest.mark.asyncio
async def test_namespace_globs_stamp_the_link_target_stat():
    # The command tier's `*/` asks the namespace what a link points at,
    # so the invocation's target_stat rides the adapter beside the child
    # names, stamped per invocation exactly like glob_children.
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    links = LinkView(
        stat_at=_no_links,
        children=_no_links,
        subtree=_no_links,
        resolve=_same,
        exists=_nothing_there,
        target_stat=_no_target,
    )
    opts = CommandOpts(
        ns=NamespaceView(links=links, child_mounts=_owes_nothing)
    )
    await _run_with_namespace_globs(
        lambda ops: ops,
        capture,
        None,
        None,
        False,
        None,
        [],
        [],
        replace(opts, io=_ops(_CountingBackend(b""))),
    )
    assert seen[0].glob_children is _owes_nothing
    assert seen[0].glob_target_stat is _no_target


@pytest.mark.asyncio
async def test_namespace_globs_stamp_nothing_without_links():
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    opts = CommandOpts(ns=NamespaceView(child_mounts=_owes_nothing))
    await _run_with_namespace_globs(
        lambda ops: ops,
        capture,
        None,
        None,
        False,
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


@pytest.mark.parametrize(
    "option",
    [
        {"overrides": {"cat", "search"}},
        {"adapt": {"lss": _same_table}},
    ],
)
def test_a_name_no_builder_has_is_refused(option):
    """A name no builder has did nothing, so a typo left the generic
    registered beside the bespoke command, and mem0's ``search`` read as
    if it displaced something."""
    with pytest.raises(ValueError, match="no generic builder named"):
        generic_commands("fake", **option)


class _CountingStat:
    def __init__(self, answer: FileStat) -> None:
        self.answer = answer
        self.calls = 0

    async def __call__(self, accessor, path, index=None) -> FileStat:
        self.calls += 1
        return self.answer


def _stat_ops(stat: _CountingStat) -> CommandIO:
    return replace(_ops(_CountingBackend(b"payload")), stat=stat)


_BACKEND = FileStat(name="a.txt", size=7, type=FileType.FILE)
_PROBED = FileStat(name="a.txt", size=9, type=FileType.FILE)


@pytest.mark.asyncio
async def test_a_command_stat_serves_what_its_probe_saw():
    # The freshness probe already asked the backend this command; asking
    # again resolves through a listing fresh has not re-checked yet.
    stat = _CountingStat(_BACKEND)
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    ops = with_stat_cache(with_probe_answers(_stat_ops(stat)))
    prev = push_cache_manager(manager)
    try:
        async with command_scope():
            manager.note_probed(_spec(), _PROBED)
            assert await ops.stat(None, _spec()) == _PROBED
    finally:
        push_cache_manager(prev)
    assert stat.calls == 0


@pytest.mark.asyncio
async def test_a_write_after_the_probe_sends_the_stat_to_the_backend():
    stat = _CountingStat(_BACKEND)
    manager = CacheManager(
        RAMFileCacheStore(), RAMIndexCacheStore(), "/s3/", True
    )
    ops = with_stat_cache(with_probe_answers(_stat_ops(stat)))
    prev = push_cache_manager(manager)
    try:
        async with command_scope():
            manager.note_probed(_spec(), _PROBED)
            await manager.invalidate_after_write(_spec())
            assert await ops.stat(None, _spec()) == _BACKEND
    finally:
        push_cache_manager(prev)
    assert stat.calls == 1


@pytest.mark.asyncio
async def test_a_probed_stat_without_a_size_still_gets_the_cached_length():
    # gdrive-native docs report no size; the rendered length is in the file
    # cache, and serving the probe's answer must not skip that backfill.
    stat = _CountingStat(_BACKEND)
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"rendered!!")
    manager = CacheManager(cache, None, "/s3/", True)
    ops = with_stat_cache(with_probe_answers(_stat_ops(stat)))
    prev = push_cache_manager(manager)
    try:
        async with command_scope():
            manager.note_probed(
                _spec(), FileStat(name="a.txt", size=None, type=FileType.FILE)
            )
            served = await ops.stat(None, _spec())
    finally:
        push_cache_manager(prev)
    assert (served.size, stat.calls) == (10, 0)


async def _bound_ops(commands, name: str, io: CommandIO) -> CommandIO:
    """The table the builder of command ``name`` is handed over ``io``."""
    fn = next(c for c in commands if c._registered_commands[0].name == name)
    seen: list[CommandIO] = []

    async def capture(ops, accessor, paths, texts, opts):
        seen.append(ops)

    finish, _builder, table, adapt, write = fn.__wrapped__.args
    await _run_with_namespace_globs(
        finish, capture, table, adapt, write, None, [], [], CommandOpts(io=io)
    )
    return seen[0]


@pytest.mark.asyncio
async def test_a_command_with_its_own_stat_never_serves_the_probe():
    # dify binds `ls` to a cheaper stat than its op table's. The probe's
    # answer is the op table's stat, so serving it there would change what a
    # warm `ls -l` prints under fresh only.
    table = _CountingStat(_BACKEND)
    light = _CountingStat(FileStat(name="a.txt", size=1, type=FileType.FILE))
    base = _stat_ops(table)
    commands = generic_commands(
        "s3", adapt={"ls": lambda io: replace(io, stat=light)}
    )
    manager = CacheManager(RAMFileCacheStore(), None, "/s3/", True)
    prev = push_cache_manager(manager)
    try:
        async with command_scope():
            manager.note_probed(_spec(), _PROBED)
            ls_stat = await (await _bound_ops(commands, "ls", base)).stat(
                None, _spec()
            )
            stat_stat = await (await _bound_ops(commands, "stat", base)).stat(
                None, _spec()
            )
    finally:
        push_cache_manager(prev)
    assert (ls_stat.size, light.calls) == (1, 1)
    assert (stat_stat, table.calls) == (_PROBED, 0)
