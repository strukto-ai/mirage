import asyncio
import errno
import os
import re

import pytest

from mirage.commands.builtin import rg_search
from mirage.commands.builtin.generic.rg import (
    labelled,
    parse_flags,
    rg_generic,
)
from mirage.commands.builtin.rg_search import RgFlags
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import (
    ContentType,
    FileStat,
    FileType,
    MountMode,
    PathSpec,
    WalkErrno,
)
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=(path).strip("/"), virtual=path, directory=path, resolved=True
    )


def _make_backend(files: dict[str, bytes], dirs: set[str] | None = None):
    inferred_dirs = set(dirs) if dirs is not None else set()
    for f in files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)
    inferred_dirs.add("/")

    async def readdir(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = spec.virtual.rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in files:
            if f.startswith(prefix):
                rest = f[len(prefix) :]
                child = rest.split("/")[0]
                children.add(prefix + child)
        for d in inferred_dirs:
            if d == p:
                continue
            if d.startswith(prefix):
                rest = d[len(prefix) :]
                child = rest.split("/")[0]
                children.add(prefix + child)
        return sorted(children)

    async def stat(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = spec.virtual
        if p in files:
            return FileStat(
                name=p.rsplit("/", 1)[-1] or p,
                size=len(files[p]),
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(
                name=p.rsplit("/", 1)[-1] or "/", type=FileType.DIRECTORY
            )
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

    async def read_stream(path):
        data = await read_bytes(path)
        yield data

    return readdir, stat, read_bytes, read_stream


async def _drain_async(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    chunks = [chunk async for chunk in stdout]
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_rg_count_stdin_zero_exits_1_without_output():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg_generic(
        [],
        ["foo"],
        CommandOpts(flags={"count": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"bar\nbaz\n",
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


def _parsed(flags: dict) -> RgFlags:
    return parse_flags(FlagView(flags, spec=SPECS["rg"]))


@pytest.mark.parametrize(
    "flags, want",
    [
        (
            {"after_context": "2", "before_context": "1", "context": "4"},
            (False, 1, 2),
        ),
        ({"context": "1", "passthru": True}, (True, 0, 0)),
        (
            {"after_context": "1", "passthru": True, "before_context": "1"},
            (False, 1, 0),
        ),
    ],
)
def test_parse_flags_context_and_passthru(flags, want):
    # ripgrep 14.1.1: -A and -B, even at 0, beat -C for their own side;
    # --passthru drops the context options before it and one after it
    # starts afresh (`-A 1 --passthru -B 1` is -B 1).
    f = _parsed(flags)
    assert (f.passthru, f.context_before, f.context_after) == want


def test_parse_flags_struct_rejects_typos():
    f = _parsed({"hidden": True})
    assert f.hidden is True
    with pytest.raises(AttributeError):
        _ = f.hiden


def _walk_refused(virtual: str, raw: str, verdict: WalkErrno) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory=virtual,
        resolved=True,
        raw_path=raw,
        walk_error=verdict,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "operand, message",
    [
        (
            ("/", "", "ENOENT"),
            b"rg: : IO error for operation on : "
            b"No such file or directory (os error 2)\n",
        ),
        (
            ("/lp1", "lp1", "ELOOP"),
            b"rg: lp1: IO error for operation on lp1: "
            b"Too many levels of symbolic links (os error 40)\n",
        ),
    ],
)
async def test_rg_refuses_an_operand_the_walk_refused(operand, message):
    # ripgrep 14.1.1: `rg o ''` and `rg o lp1` (a loop) refuse the operand
    # by name with exit 2. The empty name's `virtual` is the cwd it joined
    # onto, which must not be walked. Beside another operand the parallel
    # walker names it once.
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\n"})
    parallel = re.sub(rb"IO error for operation on [^:]*: ", b"", message)
    for paths, want, said in (
        ([_walk_refused(*operand)], b"", message),
        (
            [_spec("/a.txt"), _walk_refused(*operand)],
            b"/a.txt:hello\n",
            parallel,
        ),
    ):
        output, io = await rg_generic(
            paths,
            ["o"],
            CommandOpts(),
            readdir=readdir,
            stat=stat,
            read_bytes=rb,
            read_stream=rs,
        )
        assert await _drain_async(output) == want
        assert io.stderr == said
        assert io.exit_code == 2


@pytest.mark.asyncio
async def test_rg_lone_operand_it_may_not_read_is_the_searchers_refusal():
    # ripgrep 14.1.1 opens a lone file operand after the stat said it is
    # one, so a file it may not read is `rg: locked.txt: Permission denied
    # (os error 13)`, exit 2, not the shared handler's exit 1.
    readdir, stat, rb, _ = _make_backend({"/locked.txt": b"hit\n"})

    async def denied(path):
        raise PermissionError("/locked.txt")
        yield b""

    output, io = await rg_generic(
        [_typed("/locked.txt", "locked.txt")],
        ["hit"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=denied,
    )
    assert await _drain_async(output) == b""
    assert io.stderr == b"rg: locked.txt: Permission denied (os error 13)\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_rg_not_a_directory_operand_keeps_the_others():
    """readdir on a path whose component is a file raises ENOTDIR. rg must
    warn for that operand and keep searching the rest, as it does for ENOENT.
    """
    readdir, stat, rb, rs = _make_backend(
        {
            "/a.txt": b"hello\n",
            "/real/b.txt": b"foo\n",
        }
    )

    async def readdir_enotdir(path):
        p = path.virtual if isinstance(path, PathSpec) else path
        if p.startswith("/a.txt/"):
            raise NotADirectoryError(p)
        return await readdir(path)

    output, io = await rg_generic(
        [_spec("/a.txt/x"), _spec("/real")],
        ["foo"],
        CommandOpts(flags={"files_with_matches": True}),
        readdir=readdir_enotdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/real/b.txt\n"
    assert b"/a.txt/x" in (io.stderr or b"")


def test_rg_output_mode_is_the_last_of_c_l_and_files_without_match():
    # ripgrep 14.1.1: `-c --files-without-match` lists the matchless
    # files, `--files-without-match -c` prints counts, `-l -c` counts.
    counted = _parsed({"files_with_matches": True, "count": True})
    assert (counted.files_only, counted.count_only) == (False, True)


def _stdin_operand(raw: str = "-") -> PathSpec:
    # How the classifier hands a typed `-` over: resolved under the cwd,
    # spelled as typed.
    virtual = "/dev/stdin" if raw == "/dev/stdin" else "/-"
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory="/",
        resolved=True,
        raw_path=raw,
    )


async def _run(
    paths: list[PathSpec],
    texts: list[str],
    flags: dict,
    stdin,
    files: dict[str, bytes] | None = None,
):
    readdir, stat, rb, rs = _make_backend(files or {})
    output, io = await rg_generic(
        paths,
        texts,
        CommandOpts(flags=flags),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=stdin,
    )
    return await _drain_async(output), io


@pytest.mark.asyncio
async def test_rg_dash_twice_reads_stdin_once():
    # Both operands read one cursor: the second finds it drained.
    out, io = await _run(
        [_stdin_operand(), _stdin_operand()], ["b"], {}, b"b\n"
    )
    assert (out, io.exit_code) == (b"<stdin>:b\n", 0)
    out, io = await _run(
        [_stdin_operand(), _stdin_operand()],
        ["z"],
        {"files_without_match": True},
        b"b\n",
    )
    assert (out, io.exit_code) == (b"<stdin>\n<stdin>\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_listing_names_stdin():
    out, io = await _run(
        [_stdin_operand()], ["b"], {"files_with_matches": True}, b"b\n"
    )
    assert (out, io.exit_code) == (b"<stdin>\n", 0)
    out, io = await _run(
        [_stdin_operand()], ["b"], {"files_without_match": True}, b"b\n"
    )
    assert (out, io.exit_code) == (b"", 1)


@pytest.mark.asyncio
async def test_rg_dev_stdin_reads_stdin_under_its_own_name():
    # ripgrep opens /dev/stdin as the path it is, so a label names it.
    files = {"/a.txt": b"world\n"}
    out, io = await _run(
        [_stdin_operand("/dev/stdin"), _spec("/a.txt")],
        ["world"],
        {},
        b"world\n",
        files,
    )
    assert (out, io.exit_code) == (b"/dev/stdin:world\n/a.txt:world\n", 0)


async def _pipe_that_goes_on(first: bytes):
    yield first
    raise AssertionError("read past the answer")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paths, flags, want, code",
    [
        ([], {"files_without_match": True}, b"", 1),
        ([None], {"files_with_matches": True}, b"<stdin>\n", 0),
        ([None], {"files_without_match": True}, b"", 1),
        ([None], {"max_count": "1", "context": "1"}, b"a\nb\nc\n", 0),
        ([None], {"max_count": "1", "type": ["py"]}, b"b\n", 0),
        ([None, "/a.txt"], {"max_count": "1"}, b"<stdin>:b\n", 0),
        ([], {"files_with_matches": True}, b"<stdin>\n", 0),
        ([], {"max_count": "1", "context": "1"}, b"a\nb\nc\n", 0),
        ([], {"max_count": "1", "with_filename": True}, b"<stdin>:b\n", 0),
    ],
)
async def test_rg_stdin_is_never_read_past_the_answer(
    paths, flags, want, code
):
    # A listing is settled by the first selected line and -m once its last
    # selected line (and that line's trailing context) is out, so a pipe
    # that goes on is never waited on: `None` is a typed `-`.
    operands = [_stdin_operand() if p is None else _spec(p) for p in paths]
    out, io = await _run(
        operands,
        ["b"],
        flags,
        _pipe_that_goes_on(b"a\nb\nc\n"),
        {"/a.txt": b"hello\nworld\n"},
    )
    assert (out, io.exit_code) == (want, code)


@pytest.mark.asyncio
async def test_rg_no_operand_cancellation_closes_stdin(monkeypatch):
    # The implicit operand is stdin's sole reader, so a search cancelled
    # mid-line closes the input rather than leaving it half read.
    closed = False
    calls = 0
    task = asyncio.current_task()
    original = rg_search.ByteCursor.at

    def measured(self, index):
        nonlocal calls
        if calls == 0:
            asyncio.get_running_loop().call_later(0, task.cancel)
        calls += 1
        return original(self, index)

    async def source():
        nonlocal closed
        try:
            yield b"needle " * 100000 + b"\n"
            raise AssertionError("read beyond the matching line")
        finally:
            closed = True

    monkeypatch.setattr(rg_search.ByteCursor, "at", measured)
    with pytest.raises(asyncio.CancelledError):
        await _run(
            [],
            ["needle"],
            {"only_matching": True, "byte_offset": True},
            source(),
        )
    assert closed
    assert calls < 100000


O_FILES = {
    "/oc/x.txt": b"b1\nb22\n",
    "/ovc/abc.txt": b"abc\n",
    "/ovc/def.txt": b"def\n",
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paths, stdin, want",
    [
        ([], b"b1\nb22\n", b"3\n"),
        (["/oc"], None, b"/oc/x.txt:3\n"),
    ],
)
async def test_rg_o_c_counts_matches_not_lines(paths, stdin, want):
    # `rg -o -c '[0-9]'` over b1\nb22\n is 3 on ripgrep 14.1.1.
    out, io = await _run(
        [_spec(p) for p in paths],
        ["[0-9]"],
        {"only_matching": True, "count": True},
        stdin,
        O_FILES,
    )
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "paths, stdin, want, code",
    [
        ([], b"abc\n", b"", 1),
        (["/ovc"], None, b"/ovc/def.txt:0\n", 0),
    ],
)
async def test_rg_o_v_c_lists_an_input_that_selected_with_no_match(
    paths, stdin, want, code
):
    # ripgrep 14.1.1 counts the matches an inverted selection holds, none,
    # and still lists every input that selected a line.
    out, io = await _run(
        [_spec(p) for p in paths],
        ["abc"],
        {"only_matching": True, "invert_match": True, "count": True},
        stdin,
        O_FILES,
    )
    assert (out, io.exit_code) == (want, code)


def _typed(virtual: str, raw: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory=virtual,
        resolved=True,
        raw_path=raw,
    )


async def _run_locked(paths: list[PathSpec], flags: dict):
    files = {"/d/sub/locked.txt": b"hit\n", "/d/sub/ok.txt": b"hit\n"}
    readdir, stat, rb, rs = _make_backend(files)

    async def read_bytes(path):
        virtual = path.virtual if isinstance(path, PathSpec) else path
        if virtual == "/d/sub/locked.txt":
            raise PermissionError(
                errno.EACCES, os.strerror(errno.EACCES), virtual
            )
        return await rb(path)

    output, io = await rg_generic(
        paths,
        ["hit"],
        CommandOpts(flags=flags),
        readdir=readdir,
        stat=stat,
        read_bytes=read_bytes,
        read_stream=rs,
    )
    return await _drain_async(output), await _drain_async(io.stderr), io


@pytest.mark.asyncio
async def test_rg_walk_names_a_file_it_could_not_read_as_typed():
    out, err, io = await _run_locked([_typed("/d/sub", "sub")], {})
    assert out == b"sub/ok.txt:hit\n"
    assert err == b"rg: sub/locked.txt: Permission denied (os error 13)\n"
    assert io.exit_code == 2


def test_labelled_asks_for_the_filename_a_walk_would_have_printed():
    assert labelled(CommandOpts(flags={})).flags == {"with_filename": True}


def test_labelled_lets_dash_upper_i_win():
    opts = CommandOpts(flags={"no_filename": True})
    assert labelled(opts) is opts


async def _walked(line: str) -> tuple[str, str, int]:
    """Run ``line`` in /data, where s holds f, t holds g and a.txt says
    hello and world, beside a read-only /ro holding f, as ripgrep 14.1.1
    was pinned."""
    ro = RAMVFS()
    ro._store.files["/f"] = b"ro\n"
    ws = Workspace(
        {
            "/data": (RAMVFS(), MountMode.WRITE),
            "/ro": (ro, MountMode.READ),
        },
        mode=MountMode.WRITE,
    )
    await ws.shell(
        "cd /data && mkdir s t && printf 'hello\\nworld\\n' > a.txt"
        " && printf o > s/f && printf o > t/g"
    )
    r = await ws.shell(f"cd /data && {line}")
    return (
        (await r.materialize_stdout()).decode(),
        (await r.materialize_stderr()).decode(),
        r.exit_code,
    )


AL = "ln -s ../a.txt s/al && "
DANG = (
    "rg: {0}: IO error for operation on {0}: No such file or directory "
    "(os error 2)\n"
)
LOOP = (
    "rg: {0}: IO error for operation on {0}: Too many levels of "
    "symbolic links (os error 40)\n"
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, stdout, stderr, code",
    [
        (AL + "rg --sort path o s", "s/f:o\n", "", 0),
        (
            AL + "rg --no-follow -L --sort path o s",
            "s/al:hello\ns/al:world\ns/f:o\n",
            "",
            0,
        ),
        ("ln -s /ro s/rol && rg -L --sort path ro s", "s/rol/f:ro\n", "", 0),
        (
            "ln -s /ro s/rol && rg -L --one-file-system --files --sort path s",
            "s/f\n",
            "",
            0,
        ),
        (
            "ln -s /ro/f s/rf && rg -L --one-file-system --files --sort path s",
            "s/f\ns/rf\n",
            "",
            0,
        ),
    ],
)
async def test_rg_follows_a_walked_link_only_under_dash_upper_l(
    line: str, stdout: str, stderr: str, code: int
):
    # A link the walk meets is skipped unless -L (the last of it and
    # --no-follow) says to follow it; one to a directory is descended under
    # the link's own name, onto any mount, unless --one-file-system keeps
    # the walk on the operand's.
    assert await _walked(line) == (stdout, stderr, code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, stdout, stderr",
    [
        (
            "ln -s nowhere s/.dang && rg -L -g '*.txt' o s",
            "",
            "rg: s/.dang: No such file or directory (os error 2)\n",
        ),
        (
            "ln -s lp2 s/lp1 && ln -s lp1 s/lp2 && rg -L --sort path o s",
            "s/f:o\n",
            LOOP.format("s/lp1") + LOOP.format("s/lp2"),
        ),
        (
            "mkdir s/sub && ln -s .. s/sub/up && cd s && rg -L --files",
            "f\n",
            "rg: File system loop found: ./sub/up points to an ancestor ./\n",
        ),
    ],
)
async def test_rg_reports_a_link_it_cannot_follow_before_any_filter(
    line: str, stdout: str, stderr: str
):
    # The ignore crate follows a link before a filter sees its name, so a
    # dangling, looping or ancestor link is reported even hidden or
    # glob-excluded, each named as the walker spells it: `./x` under the
    # implicit cwd, whose matches print bare (ripgrep 14.1.1).
    assert await _walked(line) == (stdout, stderr, 2)


@pytest.mark.asyncio
async def test_rg_dash_q_keeps_status_0_past_a_dangling_link():
    assert await _walked(
        "ln -s nowhere s/dang && rg -L -q --sort path o s"
    ) == ("", DANG.format("s/dang"), 0)
