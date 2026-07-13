import pytest

from mirage.commands.builtin.generic.rg import parse_flags, rg
from mirage.commands.spec.types import FlagView
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=(path).strip("/"),
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

    async def readdir(accessor, path, index=None):
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

    async def stat(accessor, path, index=None):
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

    async def read_bytes(accessor, path, index=None):
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
        if spec.virtual not in files:
            raise FileNotFoundError(spec.virtual)
        return files[spec.virtual]

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
        ["apple"],
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"foo foo\nfoo bar\nbaz\n",
        flags={"c": True},
    )
    assert (await _drain_async(output)) == b"2\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_rg_count_stdin_zero_exits_1_without_output():
    readdir, stat, rb, rs = _make_backend({})
    output, io = await rg(
        [],
        ["foo"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        stdin=b"bar\nbaz\n",
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"c": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"args_l": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"args_l": True},
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "args_l": True,
            "hidden": True
        },
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "args_l": True,
            "type": "py"
        },
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={
            "args_l": True,
            "glob": "*.log"
        },
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

    async def readdir(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
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

    async def stat(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
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

    async def read_bytes(accessor, path, index=None):
        if index is None:
            raise FileNotFoundError("index required")
        spec = path if isinstance(path, PathSpec) else PathSpec(
            resource_path=(path).strip("/"), virtual=path, directory=path)
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
    p = PathSpec(resource_path=mount_key("/dir", "/s3"),
                 virtual="/dir",
                 directory="/dir",
                 resolved=True)
    output, _ = await rg(
        [p],
        ["apple"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
        flags={"args_l": True},
        index=object(),
    )
    decoded = (await _drain_async(output)).decode().strip()
    assert decoded == "/s3/dir/a.txt"
    assert "/s3/s3" not in decoded


@pytest.mark.asyncio
async def test_rg_single_file_threads_index():
    readdir, stat, rb = _make_prefixed_backend(
        {"/dir/a.txt": b"apple\n"},
        mount_prefix="/gd",
    )
    p = PathSpec(resource_path=mount_key("/dir/a.txt", "/gd"),
                 virtual="/dir/a.txt",
                 directory="/dir/a.txt",
                 resolved=True)
    output, _ = await rg(
        [p],
        ["apple"],
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=None,
        index=object(),
    )
    decoded = (await _drain_async(output)).decode()
    assert "apple" in decoded


@pytest.mark.asyncio
async def test_rg_multiple_dirs_searches_all():
    readdir, stat, rb, rs = _make_backend({
        "/d1/a.txt": b"apple a\n",
        "/d2/b.txt": b"apple b\n",
    })
    output, _ = await rg(
        [_spec("/d1"), _spec("/d2")],
        ["apple"],
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
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
        flags={"args_l": True},
    )
    decoded = (await _drain_async(output)).decode()
    assert "/t1.txt" in decoded
    assert "/t2.txt" in decoded


def test_parse_flags_c_overrides_a_and_b():
    f = parse_flags(FlagView({
        "A": "2",
        "B": "1",
        "C": "4"
    }),
                    never_match=False)
    assert f.context_after == 4
    assert f.context_before == 4
    f = parse_flags(FlagView({"A": "2"}), never_match=False)
    assert f.context_after == 2
    assert f.context_before == 0


def test_parse_flags_struct_rejects_typos():
    f = parse_flags(FlagView({"hidden": True}), never_match=False)
    assert f.hidden is True
    with pytest.raises(AttributeError):
        _ = f.hiden


@pytest.mark.asyncio
async def test_rg_with_filename_labels_single_file():
    readdir, stat, rb, rs = _make_backend({"/a.txt": b"apple\nbanana\n"})
    output, _ = await rg(
        [_spec("/a.txt")],
        ["ap"],
        {"H": True},
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
        {
            "H": True,
            "c": True
        },
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
        {"args_I": True},
        readdir=readdir,
        stat=stat,
        read_bytes=rb,
        read_stream=rs,
    )
    assert (await _drain_async(output)).decode() == "apple\napricot\n"
