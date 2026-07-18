import pytest

from mirage.commands.builtin.generic.grep import grep
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
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
            resource_path=(path).strip("/"), virtual=path, directory=path)
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
            resource_path=(path).strip("/"), virtual=path, directory=path)
        p = spec.virtual
        if p in files:
            return FileStat(name=p.rsplit("/", 1)[-1] or p,
                            size=len(files[p]),
                            type=FileType.TEXT)
        if p.rstrip("/") in inferred_dirs or p in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1
    assert io.stderr == b"grep: /d: Is a directory\n"


@pytest.mark.asyncio
async def test_grep_ignore_case():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"Apple\nBANANA\n"})
    output, _ = await grep(
        [_spec("/a.txt")],
        ["apple"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"i": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"v": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"c": True},
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "2"


@pytest.mark.asyncio
async def test_grep_no_match_returns_exit_1():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"hello\nworld\n"})
    output, io = await grep(
        [_spec("/a.txt")],
        ["zzz"],
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"r": True},
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded
    assert "apricot" in decoded


@pytest.mark.asyncio
async def test_grep_recursive_single_file_prefixes_filename():
    readdir, stat, rb, rs = _make_backend({
        "/log.txt":
        b"one\nerror here\ntwo\nerror again\n",
    })
    output, _ = await grep(
        [_spec("/log.txt")],
        ["error"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "r": True,
            "n": True
        },
    )
    decoded = (await _drain_async(output)).decode()
    assert decoded == "/log.txt:2:error here\n/log.txt:4:error again\n"


@pytest.mark.asyncio
async def test_grep_files_only_lists_matching_files():
    readdir, stat, rb, rs = _make_backend({
        "/dir/a.txt": b"apple\n",
        "/dir/b.txt": b"zebra\n",
    })
    output, _ = await grep(
        [_spec("/dir")],
        ["apple"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "r": True,
            "args_l": True
        },
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
            resource_path=(path).strip("/"), virtual=path, directory=path)
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
            resource_path=(path).strip("/"), virtual=path, directory=path)
        p = _full(spec.virtual)
        if p in full_files:
            return FileStat(name=p.rsplit("/", 1)[-1],
                            size=len(full_files[p]),
                            type=FileType.TEXT)
        if p.rstrip("/") in inferred_dirs:
            return FileStat(name=p.rsplit("/", 1)[-1] or "/",
                            type=FileType.DIRECTORY)
        raise FileNotFoundError(p)

    async def read_bytes(path):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
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
    p = PathSpec(resource_path=mount_key("/dir", "/s3"),
                 virtual="/dir",
                 directory="/dir",
                 resolved=True)
    output, _ = await grep(
        [p],
        ["apple"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
        flags={
            "r": True,
            "args_l": True
        },
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"hello\nworld\n",
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "r": True,
            "c": True
        },
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
        {"H": True},
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
        {
            "H": True,
            "c": True
        },
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
        {"h": True},
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
        {"q": True},
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
        {"q": True},
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
        {
            "q": True,
            "r": True
        },
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
        {
            "q": True,
            "args_l": True
        },
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
        {
            "q": True,
            "c": True
        },
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert await _drain_async(output) == b""
    assert io.exit_code == 1
