import asyncio
import errno
import os

import pytest

from mirage.commands.builtin import rg_search
from mirage.commands.builtin.generic.rg import labelled, parse_flags, rg
from mirage.commands.builtin.rg_search import RgFlags
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes], dirs: set[str] | None = None):
    inferred_dirs = set(dirs) if dirs is not None else set()
    for f in files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)
    inferred_dirs.add("/")

    async def readdir(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = spec.virtual.rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in files:
            if f.startswith(prefix):
                rest = f[len(prefix):]
                child = rest.split("/")[0]
                children.add(prefix + child)
        for d in inferred_dirs:
            if d == p:
                continue
            if d.startswith(prefix):
                rest = d[len(prefix):]
                child = rest.split("/")[0]
                children.add(prefix + child)
        return sorted(children)

    async def stat(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = spec.virtual
        if p in files:
            return FileStat(name=p.rsplit("/", 1)[-1] or p,
                            size=len(files[p]),
                            type=FileType.FILE,
                            content=ContentType.TEXT)
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
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
async def test_rg_stdin_basic():
    readdir, stat, rb, rs = _make_backend({})
    output, _ = await rg(
        [],
        ["apple"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"apple\nbanana\napricot\n",
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_rg_count_stdin_uses_match_count():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["foo"],
        CommandOpts(flags={"count": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo foo\nfoo bar\nbaz\n",
    )
    assert (await _drain_async(output)) == b"2\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_count_stdin_zero_exits_1_without_output():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
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


@pytest.mark.asyncio
async def test_rg_file_basic():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt":
        b"apple\nbanana\napricot\n",
    })
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_rg_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await rg(
        [_spec("/a.txt")],
        ["zzz"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    drained = await _drain_async(output)
    assert drained == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_dir_auto_recursive():
    """rg on a bare directory should auto-recurse (matches real ripgrep)."""
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/sub/b.txt": b"apricot\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["ap"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_rg_count_dir_skips_zero_count_files():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"foo\nbar\nfoo\n",
        "/dir/b.txt": b"bar\nbaz\n",
    })
    output, io = await rg(
        [_spec("/dir")],
        ["foo"],
        CommandOpts(flags={"count": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt:2" in decoded
    assert "/dir/b.txt" not in decoded
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_files_only_on_dir():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={"files_with_matches": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt" in decoded
    assert "/dir/b.txt" not in decoded


@pytest.mark.asyncio
async def test_rg_hidden_excluded_by_default():
    readdir, stat, rb, rs = _make_backend({
        "/dir/.hidden": b"apple\n",
        "/dir/visible.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={"files_with_matches": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/visible.txt" in decoded
    assert ".hidden" not in decoded


@pytest.mark.asyncio
async def test_rg_hidden_included_with_flag():
    readdir, stat, rb, rs = _make_backend({
        "/dir/.hidden": b"apple\n",
        "/dir/visible.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "files_with_matches": True,
            "hidden": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/visible.txt" in decoded
    assert ".hidden" in decoded


@pytest.mark.asyncio
async def test_rg_file_type_filter():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.py": b"apple\n",
        "/dir/b.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "files_with_matches": True,
            "type": ["py"]
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.py" in decoded
    assert "/dir/b.txt" not in decoded


@pytest.mark.asyncio
async def test_rg_glob_filter():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.log": b"apple\n",
        "/dir/b.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "files_with_matches": True,
            "glob": ["*.log"]
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.log" in decoded
    assert "/dir/b.txt" not in decoded


def _make_prefixed_backend(files: dict[str, bytes], mount_prefix: str):
    """Backend that mimics real s3/disk/gdrive readdir: entries returned
    are already prepended with ``mount_prefix``. Used to catch wrapper bugs
    that re-add the prefix or drop ``index``."""

    full_files = {mount_prefix + k: v for k, v in files.items()}
    inferred_dirs: set[str] = {mount_prefix or "/"}
    for f in full_files:
        parts = f.split("/")
        for i in range(1, len(parts)):
            d = "/".join(parts[:i]) or "/"
            inferred_dirs.add(d)

    def _full(p: str) -> str:
        if mount_prefix and not p.startswith(mount_prefix):
            return mount_prefix + p
        return p

    async def readdir(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual).rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in full_files:
            if f.startswith(prefix):
                child = prefix + f[len(prefix):].split("/")[0]
                children.add(child)
        for d in inferred_dirs:
            if d == p or not d.startswith(prefix):
                continue
            child = prefix + d[len(prefix):].split("/")[0]
            children.add(child)
        return sorted(children)

    async def stat(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual)
        if p in full_files:
            return FileStat(name=p.rsplit("/", 1)[-1],
                            size=len(full_files[p]),
                            type=FileType.FILE,
                            content=ContentType.TEXT)
        if p.rstrip("/") in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            vfs_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual)
        if p not in full_files:
            raise FileNotFoundError(p)
        return full_files[p]

    return readdir, stat, read_bytes


@pytest.mark.asyncio
async def test_rg_files_only_mount_prefix_not_doubled():
    readdir, stat, rb = _make_prefixed_backend(
        {
            "/dir/a.txt": b"apple\n",
            "/dir/b.txt": b"zebra\n",
        },
        mount_prefix="/s3",
    )
    p = PathSpec(vfs_path=mount_key("/dir", "/s3"),
                 virtual="/dir",
                 directory="/dir",
                 resolved=True)
    output, _ = await rg(
        [p],
        ["apple"],
        CommandOpts(flags={"files_with_matches": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_rg_multiple_dirs_searches_all():
    readdir, stat, rb, rs = _make_backend({
        "/d1/a.txt": b"apple a\n",
        "/d2/b.txt": b"apple b\n",
    })
    output, _ = await rg(
        [_spec("/d1"), _spec("/d2")],
        ["apple"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/d1/a.txt:apple a" in decoded
    assert "/d2/b.txt:apple b" in decoded


@pytest.mark.asyncio
async def test_rg_files_only_multiple_files():
    readdir, stat, rb, rs = _make_backend({
        "/t1.txt": b"apple\n",
        "/t2.txt": b"apple\n",
    })
    output, _ = await rg(
        [_spec("/t1.txt"), _spec("/t2.txt")],
        ["apple"],
        CommandOpts(flags={"files_with_matches": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/t1.txt" in decoded
    assert "/t2.txt" in decoded


def _parsed(flags: dict) -> RgFlags:
    return parse_flags(FlagView(flags, spec=SPECS["rg"]))


def test_parse_flags_a_and_b_outrank_c():
    # ripgrep 14.1.1: -A and -B, even at 0, beat -C for their own side,
    # in either order (`rg -C 2 -A 0 x` prints two lines before, none
    # after).
    f = _parsed({"after_context": "2", "before_context": "1", "context": "4"})
    assert (f.context_before, f.context_after) == (1, 2)
    f = _parsed({"context": "2", "after_context": "0"})
    assert (f.context_before, f.context_after) == (2, 0)
    f = _parsed({"after_context": "2"})
    assert (f.context_before, f.context_after) == (0, 2)


def test_parse_flags_passthru_and_context_are_last_wins():
    # --passthru drops the context options before it; one after it
    # starts afresh (ripgrep 14.1.1: `-A 1 --passthru -B 1` is -B 1).
    assert _parsed({"context": "1", "passthru": True}).passthru
    f = _parsed({"passthru": True, "context": "1"})
    assert (f.passthru, f.context_before, f.context_after) == (False, 1, 1)
    f = _parsed({
        "after_context": "1",
        "passthru": True,
        "before_context": "1"
    })
    assert (f.passthru, f.context_before, f.context_after) == (False, 1, 0)


def test_parse_flags_struct_rejects_typos():
    f = _parsed({"hidden": True})
    assert f.hidden is True
    with pytest.raises(AttributeError):
        _ = f.hiden


@pytest.mark.asyncio
async def test_rg_with_filename_labels_single_file():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\nbanana\n"})
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(flags={"with_filename": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "/a.txt:apple\n"


@pytest.mark.asyncio
async def test_rg_with_filename_labels_single_file_count():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\napricot\n"})
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(flags={
            "with_filename": True,
            "count": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "/a.txt:2\n"


@pytest.mark.asyncio
async def test_rg_no_filename_suppresses_multi_file_labels():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"apricot\n",
    })
    output, _ = await rg(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["ap"],
        CommandOpts(flags={"no_filename": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "apple\napricot\n"


LOG = (b"error: disk full\nwarning: low memory\ninfo: all good\n"
       b"error: timeout\nnote: done\n")


@pytest.mark.asyncio
async def test_rg_context_after_single_file():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, io = await rg(
        [_spec("/app.log")],
        ["warning"],
        CommandOpts(flags={"after_context": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "warning: low memory\ninfo: all good\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_context_c_merges_adjacent_groups():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["error"],
        CommandOpts(flags={"context": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == ("error: disk full\nwarning: low memory\n"
                       "info: all good\nerror: timeout\nnote: done\n")


@pytest.mark.asyncio
async def test_rg_context_line_numbers_use_dash_separator():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["warning"],
        CommandOpts(flags={
            "line_number": True,
            "after_context": "1"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "2:warning: low memory\n3-info: all good\n"


@pytest.mark.asyncio
async def test_rg_context_respects_max_count():
    readdir, stat, rb, rs = _make_backend({"/app.log": LOG})
    output, _ = await rg(
        [_spec("/app.log")],
        ["error"],
        CommandOpts(flags={
            "max_count": "1",
            "context": "1"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "error: disk full\nwarning: low memory\n"


@pytest.mark.asyncio
async def test_rg_context_separates_distant_groups():
    readdir, stat, rb, rs = _make_backend({"/f.txt": b"hit\na\nb\nc\nhit\n"})
    output, _ = await rg(
        [_spec("/f.txt")],
        ["hit"],
        CommandOpts(flags={"after_context": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "hit\na\n--\nhit\n"


@pytest.mark.asyncio
async def test_rg_dir_search_prints_labelled_context():
    # ripgrep 14.1.1 prints context in a walk too, each line led by its
    # file's name: `name:` on a match, `name-` on context.
    readdir, stat, rb, rs = _make_backend({"/dir/app.log": LOG})
    output, _ = await rg(
        [_spec("/dir")],
        ["warning"],
        CommandOpts(flags={"after_context": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == ("/dir/app.log:warning: low memory\n"
                       "/dir/app.log-info: all good\n")


@pytest.mark.asyncio
async def test_rg_no_filename_dir_walk():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"alpha one\n",
        "/dir/b.txt": b"alpha two\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        ["alpha"],
        CommandOpts(flags={"no_filename": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "alpha one\nalpha two\n"


@pytest.mark.asyncio
async def test_rg_multi_file_missing_operand_reports_and_continues():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await rg(
        [_spec("/a.txt"), _spec("/nope.txt")],
        ["o"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/a.txt:hello\n/a.txt:world\n"
    assert io.stderr == b"rg: /nope.txt: No such file or directory\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_rg_not_a_directory_operand_keeps_the_others():
    """readdir on a path whose component is a file raises ENOTDIR. rg must
    warn for that operand and keep searching the rest, as it does for ENOENT.
    """
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"hello\n",
        "/real/b.txt": b"foo\n",
    })

    async def readdir_enotdir(path):
        p = path.virtual if isinstance(path, PathSpec) else path
        if p.startswith("/a.txt/"):
            raise NotADirectoryError(p)
        return await readdir(path)

    output, io = await rg(
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


@pytest.mark.asyncio
@pytest.mark.parametrize("flags,prefix", [
    ({}, ""),
    ({
        "with_filename": True
    }, "/binary.txt:"),
    ({
        "no_filename": True
    }, ""),
    ({
        "with_filename": True,
        "no_filename": True
    }, ""),
])
async def test_rg_filename_flags_preserve_nul_matches(flags, prefix):
    readdir, stat, rb, rs = _make_backend({"/binary.txt": b"needle\0tail\n"})
    output, io = await rg(
        [_spec("/binary.txt")],
        ["needle"],
        CommandOpts(flags=flags),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == prefix.encode() + b"needle\0tail\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_no_filename_preserves_multi_file_nul_matches():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"needle\0a\n",
        "/b.txt": b"needle\0b\n",
    })
    output, io = await rg(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["needle"],
        CommandOpts(flags={"no_filename": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b"needle\0a\nneedle\0b\n"
    assert io.exit_code == 0


async def _endless_after_first_match():
    yield b"hello\n"
    raise RuntimeError("the probe read past the first selected line")


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_stops_at_the_first_match():
    # A stdin that never ends must not be buffered whole: the probe
    # streams through the scanner and stops on the first selected line.
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["hello"],
        CommandOpts(flags={"files_without_match": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=_endless_after_first_match(),
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_lists_stdin_when_nothing_matches():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["hello"],
        CommandOpts(flags={"files_without_match": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"x\ny\n",
    )
    assert await _drain_async(output) == b"<stdin>\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_files_without_match_stdin_m0_lists_nothing():
    # ripgrep 14.1.1: `printf 'x\n' | rg --files-without-match -m0 hello`
    # prints nothing and exits 1, matched input or not.
    readdir, stat, rb, rs = _make_backend({})
    for data in (b"x\n", b"hello\n"):
        output, io = await rg(
            [],
            ["hello"],
            CommandOpts(flags={
                "files_without_match": True,
                "max_count": "0"
            }),
            readdir=readdir,
            stat=stat,
            read_bytes=rb,
            read_stream=rs,
            stdin=data,
        )
        assert await _drain_async(output) == b""
        assert io.exit_code == 1


def test_rg_output_mode_is_the_last_of_c_l_and_files_without_match():
    # ripgrep 14.1.1: `-c --files-without-match` lists the matchless
    # files, `--files-without-match -c` prints counts, `-l -c` counts.
    later = _parsed({"count": True, "files_without_match": True})
    assert (later.count_only, later.files_without_match) == (False, True)
    earlier = _parsed({"files_without_match": True, "count": True})
    assert (earlier.count_only, earlier.files_without_match) == (True, False)
    counted = _parsed({"files_with_matches": True, "count": True})
    assert (counted.files_only, counted.count_only) == (False, True)


def _stdin_operand(raw: str = "-") -> PathSpec:
    # How the classifier hands a typed `-` over: resolved under the cwd,
    # spelled as typed.
    virtual = "/dev/stdin" if raw == "/dev/stdin" else "/-"
    return PathSpec(vfs_path=virtual.strip("/"),
                    virtual=virtual,
                    directory="/",
                    resolved=True,
                    raw_path=raw)


async def _run(paths: list[PathSpec],
               texts: list[str],
               flags: dict,
               stdin,
               files: dict[str, bytes] | None = None):
    readdir, stat, rb, rs = _make_backend(files or {})
    output, io = await rg(paths,
                          texts,
                          CommandOpts(flags=flags),
                          readdir=readdir,
                          stat=stat,
                          read_bytes=rb,
                          read_stream=rs,
                          stdin=stdin)
    return await _drain_async(output), io


@pytest.mark.asyncio
async def test_rg_dash_operand_reads_stdin():
    # ripgrep 14.1.1: `printf 'b\n' | rg b -` prints `b`, exit 0. The
    # backend holds no `/-`, so reading one would fail the line.
    out, io = await _run([_stdin_operand()], ["b"], {}, b"b\n")
    assert (out, io.exit_code) == (b"b\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_beside_a_file_is_named_stdin():
    files = {"/a.txt": b"hello\nworld\n"}
    out, io = await _run([_stdin_operand(), _spec("/a.txt")], ["world"], {},
                         b"world\n", files)
    assert (out, io.exit_code) == (b"<stdin>:world\n/a.txt:world\n", 0)
    out, io = await _run([_stdin_operand(), _spec("/a.txt")], ["world"],
                         {"count": True}, b"world\n", files)
    assert (out, io.exit_code) == (b"<stdin>:1\n/a.txt:1\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_twice_reads_stdin_once():
    # Both operands read one cursor: the second finds it drained.
    out, io = await _run([_stdin_operand(), _stdin_operand()], ["b"], {},
                         b"b\n")
    assert (out, io.exit_code) == (b"<stdin>:b\n", 0)
    out, io = await _run([_stdin_operand(), _stdin_operand()], ["z"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n<stdin>\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_listing_names_stdin():
    out, io = await _run([_stdin_operand()], ["b"],
                         {"files_with_matches": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n", 0)
    out, io = await _run([_stdin_operand()], ["z"],
                         {"files_with_matches": True}, b"b\n")
    assert (out, io.exit_code) == (b"", 1)
    out, io = await _run([_stdin_operand()], ["z"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"<stdin>\n", 0)
    out, io = await _run([_stdin_operand()], ["b"],
                         {"files_without_match": True}, b"b\n")
    assert (out, io.exit_code) == (b"", 1)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", [{
    "files_with_matches": True
}, {
    "files_without_match": True
}])
async def test_rg_dash_listing_stops_at_the_first_match(flags):
    # The listing is settled by the first selected line, so an endless
    # stdin is never read past it.
    out, io = await _run([_stdin_operand()], ["hello"], flags,
                         _endless_after_first_match())
    expected = (b"<stdin>\n", 0) if "files_with_matches" in flags else (b"", 1)
    assert (out, io.exit_code) == expected


@pytest.mark.asyncio
async def test_rg_dash_is_never_filtered_by_type_or_glob():
    # ripgrep searches an explicit operand whatever --type or --glob say,
    # and stdin is always explicit.
    for flags in ({"type": ["py"]}, {"glob": ["*.rs"]}):
        out, io = await _run([_stdin_operand()], ["b"], flags, b"b\n")
        assert (out, io.exit_code) == (b"b\n", 0)


@pytest.mark.asyncio
async def test_rg_dash_prints_context():
    out, io = await _run([_stdin_operand()], ["b"], {"context": "1"},
                         b"a\nb\nc\n")
    assert (out, io.exit_code) == (b"a\nb\nc\n", 0)


@pytest.mark.asyncio
async def test_rg_dev_stdin_reads_stdin_under_its_own_name():
    # ripgrep opens /dev/stdin as the path it is, so a label names it.
    files = {"/a.txt": b"world\n"}
    out, io = await _run([_stdin_operand("/dev/stdin"),
                          _spec("/a.txt")], ["world"], {}, b"world\n", files)
    assert (out, io.exit_code) == (b"/dev/stdin:world\n/a.txt:world\n", 0)


async def _pipe_that_goes_on(first: bytes):
    yield first
    raise AssertionError("read past the answer")


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, paths, want", [
    ({
        "max_count": "1",
        "context": "1"
    }, [None], b"a\nb\nc\n"),
    ({
        "max_count": "1",
        "type": ["py"]
    }, [None], b"b\n"),
    ({
        "max_count": "1"
    }, [None, "/a.txt"], b"<stdin>:b\n"),
])
async def test_rg_dash_stops_reading_at_max_count(flags, paths, want):
    # -m is answered once its last selected line (and that line's
    # trailing context) is out, so a pipe that goes on is never waited
    # on: in the full-scan branch (context, --type) and beside a file.
    operands = [_stdin_operand() if p is None else _spec(p) for p in paths]
    out, io = await _run(operands, ["b"], flags,
                         _pipe_that_goes_on(b"a\nb\nc\n"),
                         {"/a.txt": b"hello\nworld\n"})
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, data, want", [
    ({
        "files_with_matches": True
    }, b"b\n", (b"<stdin>\n", 0)),
    ({
        "with_filename": True
    }, b"b\n", (b"<stdin>:b\n", 0)),
    ({
        "with_filename": True,
        "count": True
    }, b"b\n", (b"<stdin>:1\n", 0)),
    ({
        "context": "1"
    }, b"a\nb\nc\n", (b"a\nb\nc\n", 0)),
    ({
        "type": ["rust"]
    }, b"b\n", (b"b\n", 0)),
    ({
        "files_with_matches": True,
        "max_count": "0"
    }, b"b\n", (b"", 1)),
])
async def test_rg_no_operand_searches_stdin_as_an_implicit_dash(
        flags, data, want):
    # ripgrep 14.1.1 searches a piped stdin as an implicit `-` when the
    # line names no path, so every flag answers as it does for a typed
    # one: `printf 'b\n' | rg -l b` prints `<stdin>`.
    out, io = await _run([], ["b"], flags, data)
    assert (out, io.exit_code) == want


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, want", [
    ({
        "files_with_matches": True
    }, b"<stdin>\n"),
    ({
        "max_count": "1",
        "context": "1"
    }, b"a\nb\nc\n"),
    ({
        "max_count": "1",
        "with_filename": True
    }, b"<stdin>:b\n"),
])
async def test_rg_no_operand_stops_reading_at_the_answer(flags, want):
    out, io = await _run([], ["b"], flags, _pipe_that_goes_on(b"a\nb\nc\n"))
    assert (out, io.exit_code) == (want, 0)


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
        await _run([], ["needle"], {
            "only_matching": True,
            "byte_offset": True
        }, source())
    assert closed
    assert calls < 100000


A_TXT = b"hello\nworld\nfoo\nbar\nbaz\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, paths, want", [
    ({
        "after_context": "1"
    }, ["/a.txt", "/a.txt"
        ], b"/a.txt:world\n/a.txt-foo\n--\n/a.txt:world\n/a.txt-foo\n"),
    ({
        "with_filename": True,
        "line_number": True,
        "context": "1"
    }, ["/a.txt"], b"/a.txt-1-hello\n/a.txt:2:world\n/a.txt-3-foo\n"),
    ({
        "no_filename": True,
        "after_context": "1"
    }, ["/a.txt", "/a.txt"], b"world\nfoo\n--\nworld\nfoo\n"),
])
async def test_rg_labelled_search_prints_context(flags, paths, want):
    # ripgrep 14.1.1 leads a context line with `name-` and a match with
    # `name:`, and puts `--` between one file's context and the next
    # file's, labelled or not.
    out, io = await _run([_spec(p) for p in paths], ["world"], flags, None,
                         {"/a.txt": A_TXT})
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
async def test_rg_labelled_stdin_prints_context_beside_a_file():
    # `printf 'a\nb\nc\n' | rg -C1 b - a.txt` on ripgrep 14.1.1.
    out, io = await _run([_stdin_operand(), _spec("/a.txt")], ["b"],
                         {"context": "1"}, b"a\nb\nc\n", {"/a.txt": A_TXT})
    assert (out, io.exit_code) == (b"<stdin>-a\n<stdin>:b\n<stdin>-c\n--\n"
                                   b"/a.txt-foo\n/a.txt:bar\n/a.txt:baz\n", 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("flags, want", [
    ({}, b"/sub/nested.txt:content\n"),
    ({
        "count": True
    }, b"/sub/nested.txt:1\n"),
])
async def test_rg_walks_a_directory_named_after_a_file(flags, want):
    # `rg content a.txt sub` on ripgrep 14.1.1. Only the first operand was
    # probed, so a later directory was read as a file and reported.
    files = {"/a.txt": A_TXT, "/sub/nested.txt": b"nested\ncontent\n"}
    out, io = await _run([_spec("/a.txt"), _spec("/sub")], ["content"], flags,
                         None, files)
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, stdin", [
    (["/a.txt"], None),
    ([], A_TXT),
])
async def test_rg_m_prints_a_selected_trailing_line_as_selected(paths, stdin):
    # `rg -n -m1 -A1 o a.txt` prints `2:world` on ripgrep 14.1.1, where
    # GNU grep prints `2-world`: past -m, a trailing line that would be
    # selected still prints as selected.
    out, io = await _run([_spec(p) for p in paths], ["o"], {
        "line_number": True,
        "max_count": "1",
        "after_context": "1"
    }, stdin, {"/a.txt": A_TXT})
    assert (out, io.exit_code) == (b"1:hello\n2:world\n", 0)


OCTX = b"/octx/x.txt-1-a\n/octx/x.txt:2:b\n/octx/x.txt-3-c\n"
O_FILES = {
    "/ov/x.txt": b"x\ny\nzz\n",
    "/oc/x.txt": b"b1\nb22\n",
    "/ovc/abc.txt": b"abc\n",
    "/ovc/def.txt": b"def\n",
    "/octx/x.txt": b"a\nb\nc\n",
}


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, stdin, want", [
    ([], b"x\ny\nzz\n", b"1:x\n3:zz\n"),
    (["/ov/x.txt"], None, b"1:x\n3:zz\n"),
    (["/ov"], None, b"/ov/x.txt:1:x\n/ov/x.txt:3:zz\n"),
])
async def test_rg_o_v_prints_the_unmatched_lines_whole(paths, stdin, want):
    # `rg -v -o -n y` over x\ny\nzz\n on ripgrep 14.1.1, where GNU grep
    # prints nothing: a selected line with no match prints whole.
    out, io = await _run([_spec(p) for p in paths], ["y"], {
        "only_matching": True,
        "invert_match": True,
        "line_number": True
    }, stdin, O_FILES)
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, stdin, want", [
    ([], b"b1\nb22\n", b"3\n"),
    (["/oc/x.txt"], None, b"3\n"),
    (["/oc/x.txt", "/oc/x.txt"], None, b"/oc/x.txt:3\n/oc/x.txt:3\n"),
    (["/oc"], None, b"/oc/x.txt:3\n"),
])
async def test_rg_o_c_counts_matches_not_lines(paths, stdin, want):
    # `rg -o -c '[0-9]'` over b1\nb22\n is 3 on ripgrep 14.1.1.
    out, io = await _run([_spec(p) for p in paths], ["[0-9]"], {
        "only_matching": True,
        "count": True
    }, stdin, O_FILES)
    assert (out, io.exit_code) == (want, 0)


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, stdin, want, code", [
    ([], b"abc\ndef\n", b"0\n", 0),
    ([], b"abc\n", b"", 1),
    (["/ovc/abc.txt", "/ovc/def.txt"], None, b"/ovc/def.txt:0\n", 0),
    (["/ovc"], None, b"/ovc/def.txt:0\n", 0),
])
async def test_rg_o_v_c_lists_an_input_that_selected_with_no_match(
        paths, stdin, want, code):
    # ripgrep 14.1.1 counts the matches an inverted selection holds, none,
    # and still lists every input that selected a line.
    out, io = await _run([_spec(p) for p in paths], ["abc"], {
        "only_matching": True,
        "invert_match": True,
        "count": True
    }, stdin, O_FILES)
    assert (out, io.exit_code) == (want, code)


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, stdin, want", [
    ([], b"a\nb\nc\n", b"1-a\n2:b\n3-c\n"),
    (["/octx"], None, OCTX),
    (["/octx/x.txt", "/octx/x.txt"], None, OCTX + b"--\n" + OCTX),
])
async def test_rg_o_prints_context_lines_whole(paths, stdin, want):
    # `rg -o -n -C1 b` on ripgrep 14.1.1; GNU grep -o prints no context.
    out, io = await _run([_spec(p) for p in paths], ["b"], {
        "only_matching": True,
        "line_number": True,
        "context": "1"
    }, stdin, O_FILES)
    assert (out, io.exit_code) == (want, 0)


def _typed(virtual: str, raw: str) -> PathSpec:
    return PathSpec(vfs_path=virtual.strip("/"),
                    virtual=virtual,
                    directory=virtual,
                    resolved=True,
                    raw_path=raw)


async def _run_locked(paths: list[PathSpec], flags: dict):
    files = {"/d/sub/locked.txt": b"hit\n", "/d/sub/ok.txt": b"hit\n"}
    readdir, stat, rb, rs = _make_backend(files)

    async def read_bytes(path):
        virtual = path.virtual if isinstance(path, PathSpec) else path
        if virtual == "/d/sub/locked.txt":
            raise PermissionError(errno.EACCES, os.strerror(errno.EACCES),
                                  virtual)
        return await rb(path)

    output, io = await rg(paths, ["hit"],
                          CommandOpts(flags=flags),
                          readdir=readdir,
                          stat=stat,
                          read_bytes=read_bytes,
                          read_stream=rs)
    return await _drain_async(output), await _drain_async(io.stderr), io


TYPE_TXT = {"type": ["txt"]}
LISTING = {"files_with_matches": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("paths, flags, want", [
    ([("/d/sub", "sub"), ("/d/nope", "nope")], {}, b"sub/ok.txt:hit\n"),
    ([("/d/nope", "nope")], TYPE_TXT, b""),
    ([("/d/nope", "nope"), ("/d/sub", "sub")], LISTING, b"sub/ok.txt\n"),
])
async def test_rg_walk_names_a_missing_operand_as_typed(paths, flags, want):
    # ripgrep 14.1.1: `cd /data && rg hit sub nope` reports `nope`, spelled
    # as the line spelled it, the way it prints `sub/ok.txt:hit`.
    out, err, io = await _run_locked([_typed(v, r) for v, r in paths], flags)
    assert out == want
    assert b"rg: nope: No such file or directory\n" in err
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_rg_walk_names_a_file_it_could_not_read_as_typed():
    out, err, io = await _run_locked([_typed("/d/sub", "sub")], {})
    assert out == b"sub/ok.txt:hit\n"
    assert err == b"rg: sub/locked.txt: Permission denied\n"
    assert io.exit_code == 2


def test_labelled_asks_for_the_filename_a_walk_would_have_printed():
    assert labelled(CommandOpts(flags={})).flags == {"with_filename": True}


def test_labelled_lets_dash_upper_i_win():
    opts = CommandOpts(flags={"no_filename": True})
    assert labelled(opts) is opts
