import pytest

from mirage.commands.builtin.generic.rg import rg
from mirage.types import FileStat, FileType, PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(original=path, directory=path, resolved=True)


def _make_backend(files: dict[str, bytes], dirs: set[str] | None = None):
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
        pattern="apple",
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
async def test_rg_file_basic():
    readdir, stat, rb, rs = _make_backend({
        "/a.txt":
        b"apple\nbanana\napricot\n",
    })
    output, _ = await rg(
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
async def test_rg_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await rg(
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
async def test_rg_dir_auto_recursive():
    """rg on a bare directory should auto-recurse (matches real ripgrep)."""
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/sub/b.txt": b"apricot\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        pattern="ap",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_rg_files_only_on_dir():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await rg(
        [_spec("/dir")],
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        files_only=True,
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
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        files_only=True,
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
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        files_only=True,
        hidden=True,
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
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        files_only=True,
        file_type="py",
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
        pattern="apple",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        files_only=True,
        glob_pattern="*.log",
    )
    decoded = (await _drain_async(output)).decode()
    assert "/dir/a.log" in decoded
    assert "/dir/b.txt" not in decoded


@pytest.mark.asyncio
async def test_rg_filetype_fn_dispatch_on_dir():
    """When path is dir and filetype_fns provided, rg dispatches to handler."""
    readdir, stat, rb, rs = _make_backend({
        "/dir/data.parquet": b"<binary>",
    })
    calls: list = []

    async def parquet_handler(paths, pattern, stdin=None, i=False):
        calls.append((paths, pattern))
        return b"row1-match\nrow2-match\n", None

    output, _ = await rg(
        [_spec("/dir")],
        pattern="match",
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        accessor="sentinel",
        filetype_fns={
            ".parquet":
            lambda accessor, *args, **kw: parquet_handler(*args, **kw)
        },
    )
    decoded = (await _drain_async(output)).decode()
    assert "row1-match" in decoded
    assert calls
