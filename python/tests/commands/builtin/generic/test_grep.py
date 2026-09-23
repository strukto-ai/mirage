import pytest

from mirage.commands.builtin.generic.grep import grep, labelled
from mirage.commands.config import CommandOpts
from mirage.ops.types import MountView, NamespaceView
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(vfs_path=(path).strip("/"),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes], dirs: set[str] | None = None):
    """Build (readdir, stat, read_bytes, read_stream) callables over a
    simple in-memory file tree. `dirs` is the set of directory paths;
    intermediate dirs are inferred from file paths if not specified."""

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


def _drain(stdout):
    if isinstance(stdout, bytes):
        return stdout
    return b"".join([c for c in stdout])


async def _drain_async(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    chunks = [chunk async for chunk in stdout]
    return b"".join(chunks)


@pytest.mark.asyncio
async def test_grep_stdin_basic():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await grep(
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
    assert "apricot" not in decoded


@pytest.mark.asyncio
async def test_grep_file_basic():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt":
        b"apple\nbanana\napricot\n",
    })
    output, io = await grep(
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
async def test_grep_single_dir_operand_warns():
    readdir, stat, rb, rs = _make_backend({"/d/a.txt": b"apple\n"})
    output, io = await grep(
        [_spec("/d")],
        ["ap"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 2
    assert io.stderr == b"grep: /d: Is a directory\n"


@pytest.mark.asyncio
async def test_grep_ignore_case():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"Apple\nBANANA\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        ["apple"],
        CommandOpts(flags={"i": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "Apple" in decoded


@pytest.mark.asyncio
async def test_grep_invert():
    readdir, stat, rb, rs = _make_backend(
        {"/a.txt": b"apple\nbanana\ncherry\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        ["banana"],
        CommandOpts(flags={"v": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "cherry" in decoded
    assert "banana" not in decoded


@pytest.mark.asyncio
async def test_grep_count_only():
    readdir, stat, rb, rs = _make_backend(
        {"/a.txt": b"apple\nbanana\napricot\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        ["ap"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "2"


@pytest.mark.asyncio
async def test_grep_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await grep(
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
async def test_grep_recursive_finds_files_in_subdirs():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/sub/b.txt": b"apricot\n",
    })
    output, io = await grep(
        [_spec("/dir")],
        ["ap"],
        CommandOpts(flags={"r": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_grep_recursive_single_file_keeps_single_file_output():
    readdir, stat, rb, rs = _make_backend({
        "/log.txt":
        b"one\nerror here\ntwo\nerror again\n",
    })
    output, _ = await grep(
        [_spec("/log.txt")],
        ["error"],
        CommandOpts(flags={
            "r": True,
            "n": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "2:error here\n4:error again\n"


@pytest.mark.asyncio
async def test_grep_files_only_lists_matching_files():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await grep(
        [_spec("/dir")],
        ["apple"],
        CommandOpts(flags={
            "r": True,
            "args_l": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt" in decoded
    assert "/dir/b.txt" not in decoded


def _make_prefixed_backend(files: dict[str, bytes], mount_prefix: str):
    """Backend that mimics real s3/disk/gdrive readdir: entries returned
    are already prepended with ``mount_prefix``."""

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
async def test_grep_recursive_files_only_mount_prefix():
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
    output, _ = await grep(
        [p],
        ["apple"],
        CommandOpts(flags={
            "r": True,
            "args_l": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_grep_count_only_no_match_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await grep(
        [_spec("/a.txt")],
        ["zzz"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "0"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_stdin_count_only_no_match_exit_1():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await grep(
        [],
        ["zzz"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"hello\nworld\n",
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "0"
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_count_only_multi_file_no_match_exit_1():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"hello\n",
        "/b.txt": b"world\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["zzz"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded.splitlines() == ["/a.txt:0", "/b.txt:0"]
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_count_only_multi_file_match_exit_0():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"hello\n",
        "/b.txt": b"world\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["hello"],
        CommandOpts(flags={"c": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded.splitlines() == ["/a.txt:1", "/b.txt:0"]
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_recursive_count_only_no_match_exit_1():
    readdir, stat, rb, rs = _make_backend({"/d/a.txt": b"hello\n"})
    output, io = await grep(
        [_spec("/d")],
        ["zzz"],
        CommandOpts(flags={
            "r": True,
            "c": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded.splitlines() == ["/d/a.txt:0"]
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_single_file_dash_h_prefixes_filename():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\nbanana\n"})
    output, io = await grep(
        [_spec("/a.txt")],
        ["apple"],
        CommandOpts(flags={"H": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/a.txt:apple\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_single_file_dash_h_count_prefixes_filename():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\nbanana\n"})
    output, io = await grep(
        [_spec("/a.txt")],
        ["a"],
        CommandOpts(flags={
            "H": True,
            "c": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/a.txt:2\n"


@pytest.mark.asyncio
async def test_grep_multi_file_no_filename_suppresses_prefix():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"apricot\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["ap"],
        CommandOpts(flags={"h": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "apple\napricot\n"


@pytest.mark.asyncio
async def test_grep_quiet_multi_file_suppresses_output():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"banana\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["apple"],
        CommandOpts(flags={"q": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_quiet_multi_file_no_match_exits_1():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"banana\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["zzz"],
        CommandOpts(flags={"q": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_quiet_recursive_suppresses_output():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/sub/b.txt": b"apricot\n",
    })
    output, io = await grep(
        [_spec("/dir")],
        ["ap"],
        CommandOpts(flags={
            "q": True,
            "r": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_quiet_files_only_suppresses_output():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"banana\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["apple"],
        CommandOpts(flags={
            "q": True,
            "args_l": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_quiet_count_zero_counts_exits_1():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt": b"apple\n",
        "/b.txt": b"banana\n",
    })
    output, io = await grep(
        [_spec("/a.txt"), _spec("/b.txt")],
        ["zzz"],
        CommandOpts(flags={
            "q": True,
            "c": True
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_grep_multi_file_missing_operand_matches_still_exit_2():
    """A match does not excuse an unreadable operand: GNU prints the lines it
    did find and still exits 2.
    """
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\n"})
    output, io = await grep(
        [_spec("/a.txt"), _spec("/nope.txt")],
        ["o"],
        CommandOpts(),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/a.txt:hello\n"
    assert io.stderr == b"grep: /nope.txt: No such file or directory\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_grep_recursive_not_a_directory_operand_keeps_the_others():
    """A component that exists as a file makes readdir raise ENOTDIR. GNU
    warns for that operand and still searches the rest, the same as ENOENT.
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

    async def stat_enoent(path):
        # RAM/Redis `stat` still reports a missing path as ENOENT; only
        # `readdir` splits the errno, so that is what the walk must survive.
        p = path.virtual if isinstance(path, PathSpec) else path
        if p.startswith("/a.txt/"):
            raise FileNotFoundError(p)
        return await stat(path)

    output, io = await grep(
        [_spec("/a.txt/x"), _spec("/real")],
        ["foo"],
        CommandOpts(flags={
            "r": True,
            "args_l": True
        }),
        readdir=readdir_enotdir,
        stat=stat_enoent,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/real/b.txt\n"
    assert b"/a.txt/x" in (io.stderr or b"")


def _mount_parent_ns(descendant: str) -> NamespaceView:
    """A bag whose mount table puts one mount under a path."""

    def descendants(parent: str) -> list[str]:
        base = parent.rstrip("/") or "/"
        return [descendant] if descendant.startswith(f"{base}/") else []

    return NamespaceView(mounts=MountView(descendants=descendants,
                                          visible_descendants=descendants,
                                          is_root=lambda p: False,
                                          root_of=lambda p: "/"))


@pytest.mark.asyncio
async def test_grep_reads_the_mount_boundaries_off_the_bag():
    # The boundaries used to arrive as their own keyword, which every
    # caller but the two shared builders omitted, so a namespace-only
    # ancestor read as missing on every bespoke backend. Reading them off
    # the bag is what makes that impossible to get wrong: this call passes
    # no boundary argument at all, the way a wrapper does.
    readdir, stat, rb, rs = _make_backend({})
    output, io = await grep(
        [_spec("/ghost")],
        ["x"],
        CommandOpts(flags={"r": True}, ns=_mount_parent_ns("/ghost/deep")),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    # No hits and no error: the primary backend owns nothing under the
    # parent, and the fan-out searches the mount below it separately.
    assert io.exit_code == 1
    assert io.stderr in (None, b"")


@pytest.mark.asyncio
async def test_grep_still_reports_a_path_with_no_mount_below_it():
    readdir, stat, rb, rs = _make_backend({})
    _, io = await grep(
        [_spec("/nope")],
        ["x"],
        CommandOpts(flags={"r": True}, ns=_mount_parent_ns("/ghost/deep")),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert io.exit_code == 2
    assert b"/nope" in (io.stderr or b"")


@pytest.mark.parametrize("flags, expected", [
    ({
        "r": True
    }, {
        "r": True,
        "H": True
    }),
    ({
        "r": True,
        "h": True
    }, {
        "r": True,
        "h": True
    }),
    ({
        "H": True,
        "h": True
    }, {
        "H": True,
        "h": True
    }),
    ({
        "h": True,
        "H": True
    }, {
        "h": True,
        "H": True
    }),
])
def test_labelled_asks_for_filenames_only_when_the_line_did_not_decide(
        flags, expected):
    out = labelled(CommandOpts(flags=flags))
    assert out.flags == expected
    assert list(out.flags) == list(expected)


@pytest.mark.asyncio
async def test_excluded_entry_that_fails_stat_does_not_stop_the_walk():
    readdir, stat, rb, rs = _make_backend({
        "/data/a.txt": b"apple\n",
        "/data/b.txt": b"apple\n",
    })

    async def listing(path):
        return ["/data/0ghost", *await readdir(path)]

    output, io = await grep(
        [_spec("/data")],
        ["apple"],
        CommandOpts(flags={
            "r": True,
            "exclude_dir": ["0ghost"]
        }),
        readdir=listing,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await
            _drain_async(output)) == b"/data/a.txt:apple\n/data/b.txt:apple\n"
    assert io.stderr == b"grep: /data/0ghost: No such file or directory\n"
    assert io.exit_code == 2


@pytest.mark.parametrize("flags, expected", [
    ({
        "A": "1"
    }, b"/g1:a\n/g1-b\n--\n/g2:a\n/g2-y\n"),
    ({
        "B": "1"
    }, b"/g1:a\n--\n/g2-x\n/g2:a\n"),
    ({
        "h": True,
        "A": "1"
    }, b"a\nb\n--\na\ny\n"),
    ({
        "c": True,
        "A": "1"
    }, b"/g1:1\n/g2:1\n"),
    ({}, b"/g1:a\n/g2:a\n"),
])
@pytest.mark.asyncio
async def test_grep_separates_context_groups_between_files(flags, expected):
    readdir, stat, rb, rs = _make_backend({
        "/g1": b"a\nb\nc\n",
        "/g2": b"x\na\ny\n",
    })
    output, io = await grep(
        [_spec("/g1"), _spec("/g2")],
        ["a"],
        CommandOpts(flags=flags),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == expected
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_grep_context_separator_needs_earlier_output():
    readdir, stat, rb, rs = _make_backend({
        "/g0": b"zzz\n",
        "/g2": b"x\na\ny\n",
    })
    output, io = await grep(
        [_spec("/g0"), _spec("/g2")],
        ["a"],
        CommandOpts(flags={"A": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b"/g2:a\n/g2-y\n"


@pytest.mark.asyncio
async def test_grep_recursive_separates_context_groups_between_files():
    readdir, stat, rb, rs = _make_backend({
        "/d/f1": b"a\nb\n",
        "/d/f2": b"x\na\ny\n",
    })
    output, io = await grep(
        [_spec("/d")],
        ["a"],
        CommandOpts(flags={
            "r": True,
            "A": "1"
        }),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (
        await
        _drain_async(output)) == b"/d/f1:a\n/d/f1-b\n--\n/d/f2:a\n/d/f2-y\n"


# grep -L / --files-without-match, measured on GNU grep 3.11: the listing
# is inverted but the exit status is not, -l and -L are one mode the later
# one wins, -L outranks -c, and -m0 lists the file since nothing was
# selected. Mirrored in grep_binary.test.ts.
async def _grep_lines(files, argv, flags):
    readdir, stat, rb, rs = _make_backend(files)
    output, io = await grep([_spec(p) for p in argv], ["hello"],
                            CommandOpts(flags=flags),
                            readdir=readdir,
                            stat=stat,
                            read_bytes=rb,
                            read_stream=rs)
    return (await _drain_async(output)).decode(), io.exit_code


_L_FILES = {"/m.txt": b"hello\nworld\n", "/o.txt": b"foo\n"}


@pytest.mark.asyncio
async def test_grep_L_lists_the_matchless_file_and_keeps_the_match_status():
    assert await _grep_lines(_L_FILES, ["/m.txt"],
                             {"files_without_match": True}) == ("", 0)
    assert await _grep_lines(_L_FILES, ["/o.txt"],
                             {"files_without_match": True}) == ("/o.txt\n", 1)
    assert await _grep_lines(_L_FILES, ["/m.txt", "/o.txt"],
                             {"files_without_match": True}) == ("/o.txt\n", 0)


@pytest.mark.asyncio
async def test_grep_L_outranks_c_and_m0_lists_the_file():
    assert await _grep_lines(_L_FILES, ["/m.txt", "/o.txt"], {
        "files_without_match": True,
        "c": True
    }) == ("/o.txt\n", 0)
    assert await _grep_lines(_L_FILES, ["/m.txt"], {
        "files_without_match": True,
        "m": "0"
    }) == ("/m.txt\n", 1)


@pytest.mark.asyncio
async def test_grep_l_and_L_are_one_mode_the_later_wins():
    assert await _grep_lines(_L_FILES, ["/m.txt", "/o.txt"], {
        "args_l": True,
        "files_without_match": True
    }) == ("/o.txt\n", 0)
    assert await _grep_lines(_L_FILES, ["/m.txt", "/o.txt"], {
        "files_without_match": True,
        "args_l": True
    }) == ("/m.txt\n", 0)
