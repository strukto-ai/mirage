import pytest

from mirage.commands.builtin.generic.grep import grep
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


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

    async def readdir(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        p = spec.original.rstrip("/") or "/"
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

    async def stat(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        p = spec.original
        if p in files:
            return FileStat(name=p.rsplit("/", 1)[-1] or p,
                            size=len(files[p]),
                            type=FileType.TEXT)
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        if spec.original not in files:
            raise FileNotFoundError(spec.original)
        return files[spec.original]

    async def read_stream(accessor, path, index=None):
        data = await read_bytes(accessor, path)
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
        pattern="apple",
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
        pattern="ap",
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
async def test_grep_ignore_case():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"Apple\nBANANA\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        ignore_case=True,
    )
    decoded = (await _drain_async(output)).decode()
    assert "Apple" in decoded


@pytest.mark.asyncio
async def test_grep_invert():
    readdir, stat, rb, rs = _make_backend(
        {"/a.txt": b"apple\nbanana\ncherry\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        pattern="banana",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        invert=True,
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
        pattern="ap",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        count_only=True,
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "2"


@pytest.mark.asyncio
async def test_grep_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await grep(
        [_spec("/a.txt")],
        pattern="zzz",
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
        pattern="ap",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        recursive=True,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_grep_files_only_lists_matching_files():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await grep(
        [_spec("/dir")],
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        recursive=True,
        files_only=True,
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.txt" in decoded
    assert "/dir/b.txt" not in decoded


def _make_prefixed_backend(files: dict[str, bytes], mount_prefix: str):
    """Backend that mimics real s3/disk/gdrive readdir: entries returned
    are already prepended with ``mount_prefix``. Also raises if ``index``
    is not threaded through (gdrive-style)."""

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

    async def readdir(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        p = _full(spec.original).rstrip("/") or "/"
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

    async def stat(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        p = _full(spec.original)
        if p in full_files:
            return FileStat(name=p.rsplit("/", 1)[-1],
                            size=len(full_files[p]),
                            type=FileType.TEXT)
        if p.rstrip("/") in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
        spec = path if isinstance(path, PathSpec) else PathSpec(original=path,
                                                                directory=path)
        p = _full(spec.original)
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
    p = PathSpec(original="/dir",
                 directory="/dir",
                 prefix="/s3",
                 resolved=True)
    output, _ = await grep(
        [p],
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
        recursive=True,
        files_only=True,
        index=object(),
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_grep_single_file_threads_index():
    readdir, stat, rb = _make_prefixed_backend(
        {"/dir/a.txt": b"apple\n"},
        mount_prefix="/gd",
    )
    p = PathSpec(original="/dir/a.txt",
                 directory="/dir/a.txt",
                 prefix="/gd",
                 resolved=True)
    output, _ = await grep(
        [p],
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
        index=object(),
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
