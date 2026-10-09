import asyncio
from contextlib import suppress

import pytest

from mirage.commands.builtin.generic.tail import (
    parse_flags,
    tail,
    tail_generic,
    tail_multi,
)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.shell.console import Channel
from mirage.types import (
    FileStat,
    FileType,
    MountMode,
    PathSpec,
    ReadPolicy,
    ReadSpec,
)
from mirage.utils.key_prefix import mount_key
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from tests.e2e.s3_mock import patch_s3_multi


async def _drain(gen):
    return b"".join([c async for c in gen])


async def _stream(parts):
    for part in parts:
        yield part


def _paths(*names: str) -> list[PathSpec]:
    return [
        PathSpec(
            vfs_path=mount_key(n, ""), virtual=n, directory="/d", resolved=True
        )
        for n in names
    ]


_TWENTY = b"\n".join(f"line{i}".encode() for i in range(1, 21)) + b"\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,kwargs,expected",
    [
        (_TWENTY, {}, _TWENTY[_TWENTY.index(b"line11") :]),
        (b"a\nb\nc\n", {"n": 0}, b""),
        # GNU/POSIX `tail -n -3` is the same as `tail -n 3`.
        (b"a\nb\nc\nd\ne\n", {"n": -3}, b"c\nd\ne\n"),
        (b"abc", {"c": 0}, b""),
        (bytes(range(256)), {"c": 10}, bytes(range(246, 256))),
        # GNU documents `tail -n +0` as `+1`.
        (b"a\nb\nc\n", {"from_line": 0}, b"a\nb\nc\n"),
        (b"\x00\x01\n\x02\x03\n", {"from_line": 2}, b"\x02\x03\n"),
        (b"abcdefghij", {"from_byte": 0}, b"abcdefghij"),
    ],
)
async def test_tail_cuts(body, kwargs, expected):
    assert await _drain(tail(body, **kwargs)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,kwargs,expected",
    [
        (b"a\nbb\nccc\n", {"n": 2}, b"bb\nccc\n"),
        (b"hello world", {"c": 5}, b"world"),
        (b"a\nb\nc\nd\n", {"from_line": 3}, b"c\nd\n"),
        (b"abcdef", {"from_byte": 4}, b"def"),
    ],
)
async def test_tail_reads_one_byte_chunks(body, kwargs, expected):
    parts = [bytes([byte]) for byte in body]
    assert await _drain(tail(_stream(parts), **kwargs)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "parts,kwargs,expected",
    [
        (
            [b"hel", b"lo\nwo", b"rld\n"],
            {"from_line": 1},
            [b"hel", b"lo\nwo", b"rld\n"],
        ),
        (
            [b"a\nb\nc", b"\nd\n", b"e\n"],
            {"from_line": 3},
            [b"c", b"\nd\n", b"e\n"],
        ),
        (
            [b"abc", b"defgh", b"ij"],
            {"from_byte": 3},
            [b"c", b"defgh", b"ij"],
        ),
    ],
)
async def test_tail_passes_chunks_through_once_the_skip_is_met(
    parts, kwargs, expected
):
    assert [c async for c in tail(_stream(parts), **kwargs)] == expected


# Both of tail's own flag refusals name the refused word through gnulib's
# quote(), so a byte outside 0x20-0x7e comes back escaped rather than
# interpolated raw. Every row measured against GNU coreutils 9.4 under
# `LC_ALL=C` with a raw `bytes` argv (`tail --follow=<w>`, `tail -s <w>`).
# Mirrored in tail.test.ts.
QUOTED_WORDS = [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
]


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_follow_refusal_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        parse_flags({"follow": value})
    assert str(exc.value) == (
        f"tail: invalid argument '{escaped}' for '--follow'\n"
        "Valid arguments are:\n"
        "  - 'descriptor'\n"
        "  - 'name'\n"
        "Try 'tail --help' for more information."
    )
    assert exc.value.exit_code == 1


@pytest.mark.parametrize("value,escaped", QUOTED_WORDS)
def test_sleep_interval_refusal_quotes_the_word(value, escaped):
    with pytest.raises(ValueError) as exc:
        parse_flags({"sleep_interval": f"1{value}"})
    assert str(exc.value) == (
        f"tail: invalid number of seconds: '1{escaped}'\n"
    )


# `-s` is `xstrtod` plus `0 <= s`, and the two halves answer separately.
# Every row measured on GNU coreutils 9.4 with a raw `bytes` argv
# (`tail -s <v> f`). Mirrored in tail.test.ts.
@pytest.mark.parametrize(
    "value",
    [
        "\r1",
        "0x.8p1",
        "infinity",
    ],
)
def test_sleep_interval_accepts_every_strtod_spelling(value):
    """strtod takes LEADING whitespace, hex floats and `inf` (exit 0)."""
    assert parse_flags({"sleep_interval": value}).interval >= 0


@pytest.mark.parametrize(
    "value",
    [
        "1\r",
        "0xp1",
        "nan",
    ],
)
def test_sleep_interval_refuses_what_gnu_refuses(value):
    """TRAILING whitespace is not strtod's, and `0 <= nan` is false.

    `tail -s $'1\r'` was accepted by both hosts before this, because
    python's `float()` and JavaScript's `Number()` both strip trailing
    whitespace where `xstrtod` demands the whole string be consumed.
    `nan` parses and is then refused by GNU's own `0 <= s`, while `inf`
    passes both.
    """
    with pytest.raises(ValueError):
        parse_flags({"sleep_interval": value})


# `tail --follow=d` and `--follow=n` both exit 0 (measured, coreutils
# 9.4): the two candidates share no prefix, so one letter is enough.
def test_follow_accepts_an_unambiguous_prefix():
    assert parse_flags({"follow": "d"}).follow
    assert not parse_flags({"follow": "d"}).follow_name
    assert parse_flags({"follow": "n"}).follow_name
    with pytest.raises(UsageError) as exc:
        parse_flags({"follow": "nn"})
    assert str(exc.value).startswith(
        "tail: invalid argument 'nn' for '--follow'\n"
    )


async def _bytes_read(p):
    return {"/a": b"a1\na2\na3\n", "/b": b"b1\nb2\n"}[p.virtual]


def _stream_read(p):
    async def gen():
        for ch in {"/a": [b"a1\n", b"a2\n"], "/b": [b"b1\n"]}[p.virtual]:
            yield ch

    return gen()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read,n,headers,expected",
    [
        (_bytes_read, 1, False, b"a3\nb2\n"),
        (_stream_read, 5, True, b"==> /a <==\na1\na2\n\n==> /b <==\nb1\n"),
    ],
)
async def test_tail_multi(read, n, headers, expected):
    # A reader may hand bytes or a stream; headers separate the files.
    out = await _drain(
        tail_multi(_paths("/a", "/b"), read=read, n=n, show_headers=headers)
    )
    assert out == expected


class _Growing:
    """A fake mount whose files the test grows between polls."""

    def __init__(
        self, data: dict[str, bytes | None], sized: bool = True
    ) -> None:
        # A None entry is a directory.
        self.data = data
        self.sized = sized

    async def stat(self, p: PathSpec) -> FileStat:
        if p.virtual not in self.data:
            raise FileNotFoundError(p.virtual)
        body = self.data[p.virtual]
        if body is None:
            return FileStat(
                name=p.virtual.rsplit("/", 1)[-1], type=FileType.DIRECTORY
            )
        return FileStat(
            name=p.virtual.rsplit("/", 1)[-1],
            size=len(body) if self.sized else None,
            type=FileType.FILE,
        )

    async def read(self, p: PathSpec) -> bytes:
        return self.data[p.virtual]

    async def read_range(self, p: PathSpec, offset: int, size: int) -> bytes:
        return self.data[p.virtual][offset : offset + size]


class _GoneAtRead(_Growing):
    """A fake whose file is gone at the read that follows a poll's stat,
    once, as a rotation landing between the two leaves it."""

    def __init__(
        self, data: dict[str, bytes | None], sized: bool = True
    ) -> None:
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
    return CommandOpts(
        flags={"follow": True, "sleep_interval": "0.02", **flags}
    )


@pytest.mark.asyncio
async def test_follow_prints_what_a_file_gains_and_notes_truncation():
    fs = _Growing({"/d/log": b"l1\nl2\n"})
    stream, io = await tail_generic(
        _paths("/d/log"), [], _follow_opts(), fs.stat, fs.read, fs.read_range
    )

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
    stream, _ = await tail_generic(
        _paths("/d/log"), [], _follow_opts(), fs.stat, fs.read
    )

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
    stream, io = await tail_generic(
        _paths("/d/log"), [], _follow_opts(), fs.stat, fs.read, fs.read_range
    )

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
    stream, _ = await tail_generic(
        _paths("/d/f", "/d/f"),
        [],
        _follow_opts(),
        fs.stat,
        fs.read,
        fs.read_range,
    )

    async def grow() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/f"] += b"l2\n"

    grower = asyncio.create_task(grow())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == (
        b"==> /d/f <==\nl1\n\n==> /d/f <==\nl1\n"
        b"\n==> /d/f <==\nl2\n\n==> /d/f <==\nl2\n"
    )


@pytest.mark.asyncio
async def test_follow_names_a_raw_byte_file_in_its_first_header():
    # A name byte that is not UTF-8 is written as that byte, as GNU tail
    # writes the name it was given. Mirrored in tail.test.ts.
    name = "/d/x" + chr(0xDCFF)
    fs = _Growing({name: b"l1\n"})
    stream, _ = await tail_generic(
        _paths(name),
        [],
        _follow_opts(v=True),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    chunks = await _drain_for(stream, 0.06)
    assert b"".join(chunks) == b"==> /d/x\xff <==\nl1\n"


async def _printed(job, want: bytes) -> bytes:
    shown = b""
    for _ in range(40):
        shown = await job.console.snapshot(Channel.STDOUT)
        if shown == want:
            break
        await asyncio.sleep(0.05)
    return shown


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True], ids=["cold", "warm"])
@pytest.mark.parametrize("policy", [ReadPolicy.FRESH, ReadPolicy.BOUNDED])
async def test_follow_prints_each_append_past_the_file_cache(policy, warm):
    # A follow polls at the dispatcher for what the backend holds now: neither
    # the cached body nor the stat the freshness probe kept has the bytes
    # it waits for, under either read policy.
    objects = {"log": b"l1\n"}
    vfs = S3VFS(
        S3Config(
            bucket="b",
            region="us-east-1",
            aws_access_key_id="x",
            aws_secret_access_key="x",
        )
    )
    with patch_s3_multi({"b": objects}):
        ws = Workspace(
            {"/s3": vfs}, mode=MountMode.WRITE, read=ReadSpec(policy=policy)
        )
        try:
            if warm:
                await (await ws.shell("cat /s3/log")).stdout_str()
            await ws.shell("tail -f -s 0.05 /s3/log &")
            job = ws.job_table.get(1, ws.default_session_id)
            assert job is not None
            assert await _printed(job, b"l1\n") == b"l1\n"
            for body in (b"l1\nl2\n", b"l1\nl2\nl3\n"):
                objects["log"] = body
                assert await _printed(job, body) == body
            assert (await ws.shell("kill %1")).exit_code == 0
        finally:
            await ws.close()


@pytest.mark.asyncio
async def test_follow_name_with_retry_waits_for_a_directory_to_be_replaced():
    # Pinned on coreutils 9.7: `tail -F dir` reports the directory
    # without giving up, keeps the name, and announces `has become
    # accessible` once a file stands there.
    fs = _Growing({"/d/dir": None})
    stream, io = await tail_generic(
        _paths("/d/dir"),
        [],
        _follow_opts(F=True),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is not None
    assert io.stderr == (
        b"tail: error reading '/d/dir': Is a directory\n"
        b"tail: /d/dir: cannot follow end of this type of "
        b"file\n"
    )

    async def replace() -> None:
        await asyncio.sleep(0.06)
        fs.data["/d/dir"] = b"born\n"

    grower = asyncio.create_task(replace())
    chunks = await _drain_for(stream, 0.2)
    await grower
    assert b"".join(chunks) == b"born\n"
    assert io.stderr.endswith(b"tail: '/d/dir' has become accessible\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,suffix",
    [
        ({"follow": True}, b"; giving up on this name"),
        ({"follow": "descriptor", "retry": True}, b""),
    ],
)
async def test_follow_gives_up_on_a_directory_without_name_retry(
    flags, suffix
):
    # Pinned on coreutils 9.7: without --retry the suffix says so; a
    # descriptor follow with --retry drops the suffix but gives up too.
    fs = _Growing({"/d/dir": None})
    stream, io = await tail_generic(
        _paths("/d/dir"),
        [],
        _follow_opts(**flags),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is None
    assert io.exit_code == 1
    assert io.stderr.endswith(
        b"tail: error reading '/d/dir': Is a directory\n"
        b"tail: /d/dir: cannot follow end of this "
        b"type of file" + suffix + b"\ntail: no files remaining\n"
    )


@pytest.mark.asyncio
async def test_retry_without_follow_warns_and_tails_anyway():
    # Pinned on coreutils 9.7: the warning comes first, the tail is
    # printed as if --retry were not there, and the status is the
    # operands' own.
    fs = _Growing({"/d/f": b"l1\nl2\n"})
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        CommandOpts(flags={"retry": True, "n": "1"}),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is not None
    assert await _drain(stream) == b"l2\n"
    assert io.stderr == (
        b"tail: warning: --retry ignored; --retry is useful "
        b"only when following\n"
    )
    assert io.exit_code == 0
    stream, io = await tail_generic(
        _paths("/d/nope"),
        [],
        CommandOpts(flags={"retry": True}),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is None
    assert io.stderr.startswith(
        b"tail: warning: --retry ignored; --retry is useful only when "
        b"following\ntail: "
    )
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_switches_headers_as_files_take_turns():
    fs = _Growing({"/d/p": b"p\n", "/d/q": b"q\n"})
    stream, _ = await tail_generic(
        _paths("/d/p", "/d/q"),
        [],
        _follow_opts(),
        fs.stat,
        fs.read,
        fs.read_range,
    )

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
        b"\n==> /d/p <==\np2\n\n==> /d/q <==\nq2\nq3\n"
    )


@pytest.mark.asyncio
async def test_retry_waits_for_a_file_to_appear():
    fs = _Growing({})
    stream, io = await tail_generic(
        _paths("/d/later"),
        [],
        CommandOpts(flags={"F": True, "sleep_interval": "0.02"}),
        fs.stat,
        fs.read,
        fs.read_range,
    )
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
        _paths("/d/later"),
        [],
        CommandOpts(
            flags={"F": True, "follow": "descriptor", "sleep_interval": "0.02"}
        ),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is not None
    assert io.stderr.startswith(
        b"tail: warning: --retry only effective for the initial open\ntail: "
    )
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
        b"tail: '/d/later' has appeared;  following new file\n"
    )


@pytest.mark.asyncio
async def test_follow_by_name_reports_a_file_that_vanishes():
    fs = _Growing({"/d/gone": b"x\n"})
    stream, io = await tail_generic(
        _paths("/d/gone"),
        [],
        _follow_opts(follow="name"),
        fs.stat,
        fs.read,
        fs.read_range,
    )

    async def vanish() -> None:
        await asyncio.sleep(0.06)
        del fs.data["/d/gone"]

    grower = asyncio.create_task(vanish())
    chunks = await _drain_for(stream, 0.25)
    await grower
    assert b"".join(chunks) == b"x\n"
    # Pinned on coreutils 9.7: without --retry the loss is the bare
    # error, not the inaccessible name GNU words only while it waits.
    assert io.stderr == (
        b"tail: /d/gone: No such file or directory\ntail: no files remaining\n"
    )
    assert io.exit_code == 1


def test_follow_flags_parse_gnu_spellings():
    parsed = parse_flags({"F": True})
    assert parsed.follow and parsed.follow_name and parsed.retry
    assert parse_flags({"follow": "name"}).follow_name
    assert not parse_flags({"follow": True}).follow_name
    # Scan order is dict order: the later of -f/--follow and -F picks the
    # mode, and -F's --retry half stays on either way.
    later_descriptor = parse_flags({"F": True, "follow": "descriptor"})
    assert later_descriptor.follow and later_descriptor.retry
    assert not later_descriptor.follow_name
    later_f = parse_flags({"F": True, "follow": True})
    assert later_f.retry and not later_f.follow_name
    later_big_f = parse_flags({"follow": True, "F": True})
    assert later_big_f.retry and later_big_f.follow_name
    only_retry = parse_flags({"follow": "name", "retry": True})
    assert only_retry.follow_name and only_retry.retry
    assert not parse_flags({"retry": True}).follow
    assert (
        parse_flags({"follow": True, "sleep_interval": "0.5"}).interval == 0.5
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("sized", [True, False])
async def test_follow_name_with_retry_waits_out_a_directory_replacing_the_file(
    sized,
):
    # Pinned on coreutils 9.7: a directory standing where the followed
    # file was is `has been replaced with an untailable file`; -F keeps
    # the name and reads the file that replaces it from the start, as
    # `has become accessible`. A size-unknown backend must not read the
    # directory whole to find that out.
    fs = _Growing({"/d/f": b"a\n"}, sized=sized)
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        _follow_opts(F=True),
        fs.stat,
        fs.read,
        fs.read_range,
    )
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
        b"tail: '/d/f' has become accessible\n"
    )


@pytest.mark.asyncio
async def test_follow_descriptor_prints_nothing_while_a_directory_stands_there():
    # GNU keeps reading the descriptor it opened, which gains nothing.
    fs = _Growing({"/d/f": b"a\n"})
    stream, io = await tail_generic(
        _paths("/d/f"), [], _follow_opts(), fs.stat, fs.read, fs.read_range
    )
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
    sized,
):
    # A rotation can land between a poll's stat and its read; -F then
    # takes the same road as a failed stat, `has become inaccessible`,
    # and picks the name up again from the start when it is back.
    fs = _GoneAtRead({"/d/f": b"a\n"}, sized=sized)
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        _follow_opts(F=True),
        fs.stat,
        fs.read,
        fs.read_range,
    )
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
        b"tail: '/d/f' has appeared;  following new file\n"
    )


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
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        _follow_opts(**flags),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is not None
    chunks = await _drain_for(stream, 0.3)
    assert b"".join(chunks) == b"a\n"
    assert io.exit_code == 1
    assert io.stderr == (
        (
            b"tail: warning: --retry only effective for the initial open\n"
            if "f" in flags
            else b""
        )
        + b"tail: cannot open '/d/f' for reading: No such file or directory\n"
        b"tail: '/d/f' has appeared;  following new file\n"
    )


@pytest.mark.asyncio
async def test_follow_without_retry_gives_up_on_a_failed_first_read():
    fs = _GoneAtRead({"/d/f": b"a\n"})
    fs.trip = True
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        _follow_opts(f=True),
        fs.stat,
        fs.read,
        fs.read_range,
    )
    assert stream is not None
    chunks = await _drain_for(stream, 0.3)
    assert chunks == []
    assert io.stderr == (
        b"tail: cannot open '/d/f' for reading: No such file or directory\n"
        b"tail: no files remaining\n"
    )
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_follow_name_without_retry_gives_up_on_a_read_that_finds_nothing():
    fs = _GoneAtRead({"/d/f": b"a\n"})
    stream, io = await tail_generic(
        _paths("/d/f"),
        [],
        _follow_opts(follow="name"),
        fs.stat,
        fs.read,
        fs.read_range,
    )
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
        b"tail: /d/f: No such file or directory\ntail: no files remaining\n"
    )
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
    stream, io = await tail_generic(
        _paths("/d/log"),
        [],
        _follow_opts(sleep_interval="inf"),
        fs.stat,
        fs.read,
        fs.read_range,
    )

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
