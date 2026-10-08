import pytest

from mirage.commands.builtin.generic.grep import grep_generic, labelled
from mirage.commands.config import CommandOpts
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.view.types import MountView, NamespaceView


def _spec(path: str) -> PathSpec:
    return PathSpec(
        vfs_path=(path).strip("/"), virtual=path, directory=path, resolved=True
    )


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
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = _full(spec.virtual).rstrip("/") or "/"
        if p not in inferred_dirs:
            raise FileNotFoundError(p)
        prefix = p + "/" if p != "/" else "/"
        children: set[str] = set()
        for f in full_files:
            if f.startswith(prefix):
                child = prefix + f[len(prefix) :].split("/")[0]
                children.add(child)
        for d in inferred_dirs:
            if d == p or not d.startswith(prefix):
                continue
            child = prefix + d[len(prefix) :].split("/")[0]
            children.add(child)
        return sorted(children)

    async def stat(path):
        spec = (
            path
            if isinstance(path, PathSpec)
            else PathSpec(
                vfs_path=(path).strip("/"), virtual=path, directory=path
            )
        )
        p = _full(spec.virtual)
        if p in full_files:
            return FileStat(
                name=p.rsplit("/", 1)[-1],
                size=len(full_files[p]),
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        if p.rstrip("/") in inferred_dirs:
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
    p = PathSpec(
        vfs_path=mount_key("/dir", "/s3"),
        virtual="/dir",
        directory="/dir",
        resolved=True,
    )
    output, _ = await grep_generic(
        [p],
        ["apple"],
        CommandOpts(flags={"r": True, "args_l": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_grep_recursive_not_a_directory_operand_keeps_the_others():
    """A component that exists as a file makes readdir raise ENOTDIR. GNU
    warns for that operand and still searches the rest, the same as ENOENT.
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

    async def stat_enoent(path):
        # RAM/Redis `stat` still reports a missing path as ENOENT; only
        # `readdir` splits the errno, so that is what the walk must survive.
        p = path.virtual if isinstance(path, PathSpec) else path
        if p.startswith("/a.txt/"):
            raise FileNotFoundError(p)
        return await stat(path)

    output, io = await grep_generic(
        [_spec("/a.txt/x"), _spec("/real")],
        ["foo"],
        CommandOpts(flags={"r": True, "args_l": True}),
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

    return NamespaceView(
        mounts=MountView(
            descendants=descendants,
            visible_descendants=descendants,
            is_root=lambda p: False,
            root_of=lambda p: "/",
        )
    )


@pytest.mark.asyncio
async def test_grep_reads_the_mount_boundaries_off_the_bag():
    # The boundaries used to arrive as their own keyword, which every
    # caller but the two shared builders omitted, so a namespace-only
    # ancestor read as missing on every bespoke backend. Reading them off
    # the bag is what makes that impossible to get wrong: this call passes
    # no boundary argument at all, the way a wrapper does.
    readdir, stat, rb, rs = _make_backend({})
    output, io = await grep_generic(
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
    out, io = await grep_generic(
        [_spec("/nope")],
        ["x"],
        CommandOpts(flags={"r": True}, ns=_mount_parent_ns("/ghost/deep")),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    await _drain_async(out)
    assert io.exit_code == 2
    assert b"/nope" in (io.stderr or b"")


@pytest.mark.parametrize(
    "flags, expected",
    [
        ({"r": True}, {"r": True, "H": True}),
        ({"r": True, "h": True}, {"r": True, "h": True}),
        ({"H": True, "h": True}, {"H": True, "h": True}),
        ({"h": True, "H": True}, {"h": True, "H": True}),
    ],
)
def test_labelled_asks_for_filenames_only_when_the_line_did_not_decide(
    flags, expected
):
    out = labelled(CommandOpts(flags=flags))
    assert out.flags == expected
    assert list(out.flags) == list(expected)


@pytest.mark.asyncio
async def test_excluded_entry_that_fails_stat_does_not_stop_the_walk():
    readdir, stat, rb, rs = _make_backend(
        {
            "/data/a.txt": b"apple\n",
            "/data/b.txt": b"apple\n",
        }
    )

    async def listing(path):
        return ["/data/0ghost", *await readdir(path)]

    output, io = await grep_generic(
        [_spec("/data")],
        ["apple"],
        CommandOpts(flags={"r": True, "exclude_dir": ["0ghost"]}),
        readdir=listing,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (
        await _drain_async(output)
    ) == b"/data/a.txt:apple\n/data/b.txt:apple\n"
    assert io.stderr == b"grep: /data/0ghost: No such file or directory\n"
    assert io.exit_code == 2


@pytest.mark.asyncio
async def test_grep_recursive_separates_context_groups_between_files():
    readdir, stat, rb, rs = _make_backend(
        {
            "/d/f1": b"a\nb\n",
            "/d/f2": b"x\na\ny\n",
        }
    )
    output, io = await grep_generic(
        [_spec("/d")],
        ["a"],
        CommandOpts(flags={"r": True, "A": "1"}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (
        await _drain_async(output)
    ) == b"/d/f1:a\n/d/f1-b\n--\n/d/f2:a\n/d/f2-y\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("quiet", [False, True])
async def test_recursive_grep_stops_reading_and_closes_stream(quiet):
    readdir, stat, rb, _ = _make_backend(
        {
            "/d/a/first": b"hit\n",
            "/d/a/later": b"hit\n",
            "/d/later": b"hit\n",
            "/later": b"hit\n",
        }
    )
    opened = []
    closed = []

    async def stream(path):
        opened.append(path.virtual)
        try:
            yield b"hit\n"
            raise AssertionError("read beyond the first match")
        finally:
            closed.append(path.virtual)

    output, io = await grep_generic(
        [_spec("/d"), _spec("/later")],
        ["hit"],
        CommandOpts(flags={"r": True, "q": quiet}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=stream,
    )
    assert opened == []  # Opening the command is lazy too.
    if quiet:
        assert await _drain_async(output) == b""
        assert io.exit_code == 0
    else:
        assert await anext(output) == b"/d/a/first:hit\n"
        await output.aclose()
    assert opened == ["/d/a/first"]
    assert closed == opened


@pytest.mark.asyncio
async def test_recursive_quiet_no_match_visits_every_file():
    readdir, stat, rb, _ = _make_backend({"/d/a": b"no\n", "/d/b": b"no\n"})
    opened = []

    async def stream(path):
        opened.append(path.virtual)
        yield await rb(path)

    output, io = await grep_generic(
        [_spec("/d")],
        ["hit"],
        CommandOpts(flags={"r": True, "q": True}),
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=stream,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1
    assert opened == ["/d/a", "/d/b"]
