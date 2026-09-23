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
from contextlib import suppress

import pytest

from mirage.cache.context import push_cache_manager
from mirage.cache.file.ram import RAMFileCacheStore
from mirage.cache.manager import CacheManager
from mirage.commands.builtin.generic.tail import \
    parse_flags as tail_parse_flags
from mirage.commands.builtin.generic.tail import tail_generic, tail_multi
from mirage.commands.config import CommandOpts
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(vfs_path=mount_key(n, ""),
                 virtual=n,
                 directory="/d",
                 resolved=True) for n in names
    ]


async def _collect(gen) -> bytes:
    out = b""
    async for chunk in gen:
        out += chunk
    return out


@pytest.mark.asyncio
async def test_tail_multi_bytes_reader_no_headers():
    data = {"/a": b"a1\na2\na3\n", "/b": b"b1\nb2\n"}

    async def read(p):
        return data[p.virtual]

    out = await _collect(
        tail_multi(_paths("/a", "/b"), read=read, n=1, show_headers=False))
    assert out == b"a3\nb2\n"


@pytest.mark.asyncio
async def test_tail_multi_with_headers():
    data = {"/a": b"a1\na2\n", "/b": b"b1\nb2\n"}

    async def read(p):
        return data[p.virtual]

    out = await _collect(
        tail_multi(_paths("/a", "/b"), read=read, n=1, show_headers=True))
    assert out == b"==> /a <==\na2\n\n==> /b <==\nb2\n"


@pytest.mark.asyncio
async def test_tail_multi_stream_reader():
    chunks = {"/a": [b"a1\n", b"a2\n"], "/b": [b"b1\n"]}

    def read(p):

        async def gen():
            for ch in chunks[p.virtual]:
                yield ch

        return gen()

    out = await _collect(
        tail_multi(_paths("/a", "/b"), read=read, n=5, show_headers=True))
    assert out == b"==> /a <==\na1\na2\n\n==> /b <==\nb1\n"


# ── tail -f: the poll loop, its notices, and its refusals ──────────


class _Growing:
    """A fake mount whose files the test grows between polls."""

    def __init__(self,
                 data: dict[str, bytes | None],
                 sized: bool = True) -> None:
        # A None entry is a directory.
        self.data = data
        self.sized = sized

    async def stat(self, p: PathSpec) -> FileStat:
        if p.virtual not in self.data:
            raise FileNotFoundError(p.virtual)
        body = self.data[p.virtual]
        if body is None:
            return FileStat(name=p.virtual.rsplit("/", 1)[-1],
                            type=FileType.DIRECTORY)
        return FileStat(name=p.virtual.rsplit("/", 1)[-1],
                        size=len(body) if self.sized else None,
                        type=FileType.FILE)

    async def read(self, p: PathSpec) -> bytes:
        return self.data[p.virtual]

    async def read_range(self, p: PathSpec, offset: int, size: int) -> bytes:
        return self.data[p.virtual][offset:offset + size]


class _GoneAtRead(_Growing):
    """A fake whose file is gone at the read that follows a poll's stat,
    once, as a rotation landing between the two leaves it."""

    def __init__(self,
                 data: dict[str, bytes | None],
                 sized: bool = True) -> None:
        super().__init__(data, sized)
        self.trip = False

    def _tripped(self, p: PathSpec) -> bool:
        if not self.trip:
            return False
        self.trip = False
        raise FileNotFoundError(p.virtual)

    async def read(self, p: PathSpec) -> bytes:
        self._tripped(p)
        return await super().read(p)

    async def read_range(self, p: PathSpec, offset: int, size: int) -> bytes:
        self._tripped(p)
        return await super().read_range(p, offset, size)


async def _drain_for(gen, seconds: float) -> list[bytes]:
    chunks: list[bytes] = []

    async def drain() -> None:
        async for chunk in gen:
            chunks.append(chunk)

    task = asyncio.create_task(drain())
    await asyncio.sleep(seconds)
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    return chunks


def _follow_opts(**flags) -> CommandOpts:
    return CommandOpts(flags={
        "follow": True,
        "sleep_interval": "0.02",
        **flags
    })


@pytest.mark.asyncio
async def test_follow_prints_what_a_file_gains_and_notes_truncation():
    fs = _Growing({"/d/log": b"l1\nl2\n"})
    stream, io = await tail_generic(_paths("/d/log"), [], _follow_opts(),
                                    fs.stat, fs.read, fs.read_range)

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/log"] += b"l3\n"
        await asyncio.sleep(0.06)
        fs.data["/d/log"] = b"z\n"
        await asyncio.sleep(0.06)
        fs.data["/d/log"] += b"y\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.35)
    await grower
    assert b"".join(chunks) == b"l1\nl2\nl3\nz\ny\n"
    assert io.stderr == b"tail: /d/log: file truncated\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_follow_reads_whole_when_the_backend_has_no_range():
    fs = _Growing({"/d/log": b"a\n"})
    stream, _ = await tail_generic(_paths("/d/log"), [], _follow_opts(),
                                   fs.stat, fs.read)

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/log"] += b"b\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == b"a\nb\n"


@pytest.mark.asyncio
async def test_follow_reads_a_size_unknown_file_whole_every_poll():
    fs = _Growing({"/d/log": b"a\n"}, sized=False)
    stream, io = await tail_generic(_paths("/d/log"), [], _follow_opts(),
                                    fs.stat, fs.read, fs.read_range)

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/log"] += b"b\n"
        await asyncio.sleep(0.06)
        fs.data["/d/log"] = b"z\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"a\nb\nz\n"
    assert io.stderr == b"tail: /d/log: file truncated\n"


@pytest.mark.asyncio
async def test_follow_prints_a_repeated_operand_once_per_occurrence():
    fs = _Growing({"/d/f": b"l1\n"})
    stream, _ = await tail_generic(_paths("/d/f", "/d/f"), [], _follow_opts(),
                                   fs.stat, fs.read, fs.read_range)

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] += b"l2\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == (b"==> /d/f <==\nl1\n\n==> /d/f <==\nl1\n"
                                b"\n==> /d/f <==\nl2\n\n==> /d/f <==\nl2\n")


@pytest.mark.asyncio
async def test_follow_reads_past_the_read_through_cache():
    # A warm cache holds the body the last one-shot read saw; a follow
    # polls for exactly what that body does not have yet, so it reads
    # the backend itself, from the first print on.
    fs = _Growing({"/s3/a.txt": b"l1\n"})
    spec = PathSpec(vfs_path=mount_key("/s3/a.txt", "/s3/"),
                    virtual="/s3/a.txt",
                    directory="/s3/",
                    resolved=True)
    cache = RAMFileCacheStore()
    await cache.set("/s3/a.txt", b"stale\n")
    prev = push_cache_manager(CacheManager(cache, None, "/s3/", True))
    try:
        stream, _ = await tail_generic([spec], [], _follow_opts(), fs.stat,
                                       fs.read)
        assert stream is not None

        async def grow() -> None:
            await asyncio.sleep(0.06)
            fs.data["/s3/a.txt"] += b"l2\n"

        grower = asyncio.create_task(grow())
        chunks = await _drain_for(stream, 0.2)
        await grower
    finally:
        push_cache_manager(prev)
    assert b"".join(chunks) == b"l1\nl2\n"


@pytest.mark.asyncio
async def test_follow_name_with_retry_waits_for_a_directory_to_be_replaced():
    # Pinned on coreutils 9.7: `tail -F dir` reports the directory
    # without giving up, keeps the name, and announces `has become
    # accessible` once a file stands there.
    fs = _Growing({"/d/dir": None})
    stream, io = await tail_generic(_paths("/d/dir"), [], _follow_opts(F=True),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None
    assert io.stderr == (b"tail: /d/dir: Is a directory\n"
                         b"tail: /d/dir: cannot follow end of this type of "
                         b"file\n")

    async def replace() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/dir"] = b"born\n"

    grower = asyncio.create_task(replace())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == b"born\n"
    assert io.stderr.endswith(b"tail: '/d/dir' has become accessible\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,suffix", [
    ({
        "follow": True
    }, b"; giving up on this name"),
    ({
        "follow": "descriptor",
        "retry": True
    }, b""),
])
async def test_follow_gives_up_on_a_directory_without_name_retry(
        flags, suffix):
    # Pinned on coreutils 9.7: without --retry the suffix says so; a
    # descriptor follow with --retry drops the suffix but gives up too.
    fs = _Growing({"/d/dir": None})
    stream, io = await tail_generic(_paths("/d/dir"), [],
                                    _follow_opts(**flags), fs.stat, fs.read,
                                    fs.read_range)
    assert stream is None
    assert io.exit_code == 1
    assert io.stderr.endswith(b"tail: /d/dir: Is a directory\n"
                              b"tail: /d/dir: cannot follow end of this "
                              b"type of file" + suffix +
                              b"\ntail: no files remaining\n")


@pytest.mark.asyncio
async def test_retry_without_follow_warns_and_tails_anyway():
    # Pinned on coreutils 9.7: the warning comes first, the tail is
    # printed as if --retry were not there, and the status is the
    # operands' own.
    fs = _Growing({"/d/f": b"l1\nl2\n"})
    stream, io = await tail_generic(
        _paths("/d/f"), [], CommandOpts(flags={
            "retry": True,
            "n": "1"
        }), fs.stat, fs.read, fs.read_range)
    assert stream is not None
    assert await _collect(stream) == b"l2\n"
    assert io.stderr == (b"tail: warning: --retry ignored; --retry is useful "
                         b"only when following\n")
    assert io.exit_code == 0
    stream, io = await tail_generic(_paths("/d/nope"), [],
                                    CommandOpts(flags={"retry": True}),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is None
    assert io.stderr.startswith(
        b"tail: warning: --retry ignored; --retry is useful only when "
        b"following\ntail: ")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_switches_headers_as_files_take_turns():
    fs = _Growing({"/d/p": b"p\n", "/d/q": b"q\n"})
    stream, _ = await tail_generic(_paths("/d/p", "/d/q"), [], _follow_opts(),
                                   fs.stat, fs.read, fs.read_range)

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/p"] += b"p2\n"
        await asyncio.sleep(0.06)
        fs.data["/d/q"] += b"q2\n"
        await asyncio.sleep(0.06)
        fs.data["/d/q"] += b"q3\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.35)
    await grower
    assert b"".join(chunks) == (
        b"==> /d/p <==\np\n\n==> /d/q <==\nq\n"
        b"\n==> /d/p <==\np2\n\n==> /d/q <==\nq2\nq3\n")


@pytest.mark.asyncio
async def test_follow_with_nothing_to_follow_says_so():
    fs = _Growing({})
    stream, io = await tail_generic(_paths("/d/nope"), [], _follow_opts(),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is None
    assert io.exit_code == 1
    assert io.stderr.endswith(b"tail: no files remaining\n")


@pytest.mark.asyncio
async def test_retry_waits_for_a_file_to_appear():
    fs = _Growing({})
    stream, io = await tail_generic(
        _paths("/d/later"), [],
        CommandOpts(flags={
            "F": True,
            "sleep_interval": "0.02"
        }), fs.stat, fs.read, fs.read_range)
    assert stream is not None

    async def appear() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/later"] = b"born\n"

    grower = asyncio.create_task(appear())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"born\n"
    assert b"tail: '/d/later' has appeared;  following new file\n" in io.stderr


@pytest.mark.asyncio
async def test_retry_under_a_descriptor_covers_the_initial_open_only():
    fs = _Growing({})
    stream, io = await tail_generic(
        _paths("/d/later"), [],
        CommandOpts(flags={
            "F": True,
            "follow": "descriptor",
            "sleep_interval": "0.02"
        }), fs.stat, fs.read, fs.read_range)
    assert stream is not None
    assert io.stderr.startswith(
        b"tail: warning: --retry only effective for the initial open\n"
        b"tail: ")
    assert io.stderr.endswith(b"No such file or directory\n")

    async def appear_then_vanish() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/later"] = b"born\n"
        await asyncio.sleep(0.1)
        del fs.data["/d/later"]

    grower = asyncio.create_task(appear_then_vanish())
    chunks = await _drain_for(stream, 0.3)
    await grower
    assert b"".join(chunks) == b"born\n"
    assert io.stderr.endswith(
        b"tail: '/d/later' has appeared;  following new file\n")


@pytest.mark.asyncio
async def test_follow_by_name_reports_a_file_that_vanishes():
    fs = _Growing({"/d/gone": b"x\n"})
    stream, io = await tail_generic(_paths("/d/gone"), [],
                                    _follow_opts(follow="name"), fs.stat,
                                    fs.read, fs.read_range)

    async def vanish() -> None:
        await asyncio.sleep(0.06)
        del fs.data["/d/gone"]

    grower = asyncio.create_task(vanish())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"x\n"
    assert io.stderr == (b"tail: '/d/gone' has become inaccessible: "
                         b"No such file or directory\n"
                         b"tail: no files remaining\n")
    assert io.exit_code == 1


def test_follow_flags_parse_gnu_spellings():
    parsed = tail_parse_flags({"F": True})
    assert parsed.follow and parsed.follow_name and parsed.retry
    assert tail_parse_flags({"follow": "name"}).follow_name
    assert not tail_parse_flags({"follow": True}).follow_name
    # Scan order is dict order: the later of -f/--follow and -F picks the
    # mode, and -F's --retry half stays on either way.
    later_descriptor = tail_parse_flags({"F": True, "follow": "descriptor"})
    assert later_descriptor.follow and later_descriptor.retry
    assert not later_descriptor.follow_name
    later_f = tail_parse_flags({"F": True, "follow": True})
    assert later_f.retry and not later_f.follow_name
    later_big_f = tail_parse_flags({"follow": True, "F": True})
    assert later_big_f.retry and later_big_f.follow_name
    only_retry = tail_parse_flags({"follow": "name", "retry": True})
    assert only_retry.follow_name and only_retry.retry
    assert not tail_parse_flags({"retry": True}).follow
    assert tail_parse_flags({
        "follow": True,
        "sleep_interval": "0.5"
    }).interval == 0.5
    with pytest.raises(ValueError) as bad_follow:
        tail_parse_flags({"follow": "bogus"})
    # A UsageError's message carries no trailing newline: the executor
    # writes `f"{exc}\n"`, so one here would render a blank line into
    # stderr. `argmatch_error` rstrips it for that reason, and the
    # end-to-end bytes are asserted in tests/commands/spec/test_usage.py
    # and by the integ battery.
    assert str(bad_follow.value) == (
        "tail: invalid argument 'bogus' for '--follow'\n"
        "Valid arguments are:\n  - 'descriptor'\n  - 'name'\n"
        "Try 'tail --help' for more information.")
    with pytest.raises(ValueError) as bad_seconds:
        tail_parse_flags({"follow": True, "sleep_interval": "bogus"})
    assert str(
        bad_seconds.value) == "tail: invalid number of seconds: 'bogus'\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("sized", [True, False])
async def test_follow_name_with_retry_waits_out_a_directory_replacing_the_file(
        sized):
    # Pinned on coreutils 9.7: a directory standing where the followed
    # file was is `has been replaced with an untailable file`; -F keeps
    # the name and reads the file that replaces it from the start, as
    # `has become accessible`. A size-unknown backend must not read the
    # directory whole to find that out.
    fs = _Growing({"/d/f": b"a\n"}, sized=sized)
    stream, io = await tail_generic(_paths("/d/f"), [], _follow_opts(F=True),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None

    async def replace() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = None
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = b"b\n"

    grower = asyncio.create_task(replace())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"a\nb\n"
    assert io.stderr == (
        b"tail: '/d/f' has been replaced with an untailable file\n"
        b"tail: '/d/f' has become accessible\n")


@pytest.mark.asyncio
async def test_follow_name_without_retry_gives_up_on_a_replacing_directory():
    fs = _Growing({"/d/f": b"a\n"})
    stream, io = await tail_generic(_paths("/d/f"), [],
                                    _follow_opts(follow="name"), fs.stat,
                                    fs.read, fs.read_range)
    assert stream is not None

    async def replace() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = None

    grower = asyncio.create_task(replace())
    out = await _collect(stream)
    await grower
    assert out == b"a\n"
    assert io.stderr == (
        b"tail: '/d/f' has been replaced with an untailable file; giving up "
        b"on this name\ntail: no files remaining\n")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_descriptor_prints_nothing_while_a_directory_stands_there(
):
    # GNU keeps reading the descriptor it opened, which gains nothing.
    fs = _Growing({"/d/f": b"a\n"})
    stream, io = await tail_generic(_paths("/d/f"), [], _follow_opts(),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None

    async def replace() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = None

    grower = asyncio.create_task(replace())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == b"a\n"
    assert not io.stderr
    assert io.exit_code == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("sized", [True, False])
async def test_follow_name_treats_a_read_that_finds_nothing_as_inaccessible(
        sized):
    # A rotation can land between a poll's stat and its read; -F then
    # takes the same road as a failed stat, `has become inaccessible`,
    # and picks the name up again from the start when it is back.
    fs = _GoneAtRead({"/d/f": b"a\n"}, sized=sized)
    stream, io = await tail_generic(_paths("/d/f"), [], _follow_opts(F=True),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None

    async def rotate() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = b"a\nb\n"
        fs.trip = True

    grower = asyncio.create_task(rotate())
    chunks = await _drain_for(stream, 0.3)
    await grower
    assert b"".join(chunks) == b"a\na\nb\n"
    assert io.stderr == (
        b"tail: '/d/f' has become inaccessible: No such file or directory\n"
        b"tail: '/d/f' has appeared;  following new file\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{"F": True}, {"f": True, "retry": True}])
async def test_retry_waits_for_an_operand_whose_first_read_fails(flags):
    # The first read is the open (there is no handle to hold), so one
    # that fails after the operand's stat passed is a failed open:
    # reported as the stat's failure would have been, and waited for
    # under --retry, which covers the initial open under a descriptor
    # follow too.
    fs = _GoneAtRead({"/d/f": b"a\n"})
    fs.trip = True
    stream, io = await tail_generic(_paths("/d/f"), [], _follow_opts(**flags),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None
    chunks = await _drain_for(stream, 0.3)
    assert b"".join(chunks) == b"a\n"
    assert io.exit_code == 1
    assert io.stderr == (
        (b"tail: warning: --retry only effective for the initial open\n"
         if "f" in flags else b"") + b"tail: /d/f: No such file or directory\n"
        b"tail: '/d/f' has appeared;  following new file\n")


@pytest.mark.asyncio
async def test_follow_without_retry_gives_up_on_a_failed_first_read():
    fs = _GoneAtRead({"/d/f": b"a\n"})
    fs.trip = True
    stream, io = await tail_generic(_paths("/d/f"), [], _follow_opts(f=True),
                                    fs.stat, fs.read, fs.read_range)
    assert stream is not None
    chunks = await _drain_for(stream, 0.3)
    assert chunks == []
    assert io.stderr == (b"tail: /d/f: No such file or directory\n"
                         b"tail: no files remaining\n")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_name_without_retry_gives_up_on_a_read_that_finds_nothing(
):
    fs = _GoneAtRead({"/d/f": b"a\n"})
    stream, io = await tail_generic(_paths("/d/f"), [],
                                    _follow_opts(follow="name"), fs.stat,
                                    fs.read, fs.read_range)
    assert stream is not None

    async def rotate() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] = b"a\nb\n"
        fs.trip = True

    grower = asyncio.create_task(rotate())
    chunks = await _drain_for(stream, 0.3)
    await grower
    assert b"".join(chunks) == b"a\n"
    assert io.stderr == (
        b"tail: '/d/f' has become inaccessible: No such file or directory\n"
        b"tail: no files remaining\n")
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_infinite_interval_never_polls():
    """`tail -f -s inf` waits forever, so growth is never picked up.

    GNU accepts `inf`: its test is `xstrtod(...) && 0 <= s` and `inf`
    passes both halves (measured, coreutils 9.4). `asyncio.sleep(inf)`
    already waits, so this is a guard rather than a fix -- the
    TypeScript twin needed the fix, because `setTimeout` holds a 32-bit
    signed delay and clamps `Infinity` to 1ms, which polls continuously.
    Both hosts must report the same thing here: the first window and
    nothing after it.
    """
    fs = _Growing({"/d/log": b"l1\nl2\n"})
    stream, io = await tail_generic(_paths("/d/log"), [],
                                    _follow_opts(sleep_interval="inf"),
                                    fs.stat, fs.read, fs.read_range)

    async def grow() -> None:
        await asyncio.sleep(0.04)
        fs.data["/d/log"] += b"l3\n"
        await asyncio.sleep(0.04)
        fs.data["/d/log"] += b"l4\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"l1\nl2\n"
    assert io.exit_code == 0
