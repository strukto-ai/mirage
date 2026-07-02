import pytest

from mirage.commands.builtin.generic.diff import diff
from mirage.commands.builtin.generic.jq import jq
from mirage.commands.builtin.generic.patch import patch
from mirage.commands.builtin.generic.tar import tar
from mirage.commands.builtin.generic.tsort import tsort
from mirage.commands.builtin.generic.unzip import unzip
from mirage.commands.builtin.generic.zip_cmd import zip_cmd
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def _spec(path: str, prefix: str = "") -> PathSpec:
    return PathSpec(resource_path=mount_key(path, prefix),
                    virtual=path,
                    directory=path,
                    resolved=True)


def _make_backend(files: dict[str, bytes]):
    store = dict(files)

    async def read_bytes(accessor, path, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        return store[key]

    async def write_bytes(accessor, path, data, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        store[key] = data

    async def read_stream(accessor, path, index=None):
        key = path.virtual if isinstance(path, PathSpec) else path
        if key not in store:
            raise FileNotFoundError(key)
        yield store[key]

    async def mkdir_fn(accessor, path, parents=False):
        pass

    return read_bytes, write_bytes, read_stream, mkdir_fn, store


@pytest.mark.asyncio
async def test_tsort_basic():
    rb, _, _, _, _ = _make_backend({"deps": b"a b\nb c\n"})
    out, io = await tsort([_spec("deps")], read_bytes=rb)
    assert out == b"a\nb\nc\n"
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_tsort_cycle_detection():
    rb, _, _, _, _ = _make_backend({"deps": b"a b\nb a\n"})
    out, io = await tsort([_spec("deps")], read_bytes=rb)
    assert b"cycle" in out
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_tsort_odd_tokens():
    rb, _, _, _, _ = _make_backend({"deps": b"a b c\n"})
    out, io = await tsort([_spec("deps")], read_bytes=rb)
    assert b"odd number" in out
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_tsort_stdin():
    rb, _, _, _, _ = _make_backend({})
    out, io = await tsort([], read_bytes=rb, stdin=b"x y\ny z\n")
    assert out == b"x\ny\nz\n"


@pytest.mark.asyncio
async def test_jq_simple_object():
    rb, _, rs, _, _ = _make_backend({"a.json": b'{"name":"alice","age":30}'})
    out, _ = await jq([_spec("a.json")],
                      ".name",
                      read_bytes=rb,
                      read_stream=rs)
    assert b'"alice"' in out


@pytest.mark.asyncio
async def test_jq_raw_output():
    rb, _, rs, _, _ = _make_backend({"a.json": b'{"name":"alice"}'})
    out, _ = await jq([_spec("a.json")],
                      ".name",
                      read_bytes=rb,
                      read_stream=rs,
                      r=True)
    assert b"alice" in out
    assert b'"' not in out


@pytest.mark.asyncio
async def test_jq_stdin():
    rb, _, rs, _, _ = _make_backend({})
    out, _ = await jq([],
                      ".x",
                      read_bytes=rb,
                      read_stream=rs,
                      stdin=b'{"x":42}')
    assert b"42" in out


@pytest.mark.asyncio
async def test_jq_missing_expression_defaults_dot():
    rb, _, rs, _, _ = _make_backend({})
    out, io = await jq([], read_bytes=rb, read_stream=rs, stdin=b'{"x":42}')
    assert b"42" in out
    assert io.exit_code == 0
    out, io = await jq([], read_bytes=rb, read_stream=rs)
    assert out is None
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_jq_no_input():
    rb, _, rs, _, _ = _make_backend({})
    out, io = await jq([], ".x", read_bytes=rb, read_stream=rs)
    assert out is None
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_zip_basic():
    rb, wb, _, _, store = _make_backend({
        "f1.txt": b"hello",
        "f2.txt": b"world"
    })
    out, io = await zip_cmd(
        [_spec("out.zip"), _spec("f1.txt"),
         _spec("f2.txt")],
        read_bytes=rb,
        write_bytes=wb)
    assert b"adding" in out
    assert "out.zip" in store
    archive = store["out.zip"]
    assert archive.startswith(b"PK")


@pytest.mark.asyncio
async def test_zip_quiet():
    rb, wb, _, _, _ = _make_backend({"f.txt": b"x"})
    out, _ = await zip_cmd([_spec("o.zip"), _spec("f.txt")],
                           read_bytes=rb,
                           write_bytes=wb,
                           q=True)
    assert out is None


@pytest.mark.asyncio
async def test_zip_too_few_paths():
    rb, wb, _, _, _ = _make_backend({})
    with pytest.raises(ValueError, match="usage"):
        await zip_cmd([_spec("only.zip")], read_bytes=rb, write_bytes=wb)


@pytest.mark.asyncio
async def test_unzip_extracts():
    import io as _io
    import zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", b"hello")
        zf.writestr("sub/b.txt", b"world")
    rb, wb, _, mk, store = _make_backend({"a.zip": buf.getvalue()})
    out, io_res = await unzip([_spec("a.zip")],
                              read_bytes=rb,
                              write_bytes=wb,
                              mkdir_fn=mk)
    assert b"inflating" in out
    assert "/a.txt" in io_res.writes
    assert "/sub/b.txt" in io_res.writes


@pytest.mark.asyncio
async def test_unzip_list():
    import io as _io
    import zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("file.txt", b"data")
    rb, wb, _, mk, _ = _make_backend({"a.zip": buf.getvalue()})
    out, _ = await unzip([_spec("a.zip")],
                         read_bytes=rb,
                         write_bytes=wb,
                         mkdir_fn=mk,
                         args_l=True)
    assert b"file.txt" in out


@pytest.mark.asyncio
async def test_unzip_test_mode():
    import io as _io
    import zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("ok.txt", b"x")
    rb, wb, _, mk, _ = _make_backend({"a.zip": buf.getvalue()})
    out, _ = await unzip([_spec("a.zip")],
                         read_bytes=rb,
                         write_bytes=wb,
                         mkdir_fn=mk,
                         t=True)
    assert b"No errors" in out


@pytest.mark.asyncio
async def test_unzip_pipe_mode():
    import io as _io
    import zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", b"hello")
    rb, wb, _, mk, _ = _make_backend({"a.zip": buf.getvalue()})
    out, _ = await unzip([_spec("a.zip")],
                         read_bytes=rb,
                         write_bytes=wb,
                         mkdir_fn=mk,
                         p=True)
    assert out == b"hello"


@pytest.mark.asyncio
async def test_tar_create_and_list():
    rb, wb, _, mk, store = _make_backend({"a.txt": b"alpha", "b.txt": b"beta"})
    _, io_res = await tar([_spec("a.txt"), _spec("b.txt")],
                          read_bytes=rb,
                          write_bytes=wb,
                          mkdir_fn=mk,
                          c=True,
                          f=_spec("out.tar"))
    assert "/out.tar" in io_res.writes
    out, _ = await tar([],
                       read_bytes=rb,
                       write_bytes=wb,
                       mkdir_fn=mk,
                       t=True,
                       f=_spec("out.tar"))
    assert b"a.txt" in out
    assert b"b.txt" in out


@pytest.mark.asyncio
async def test_tar_extract():
    rb, wb, _, mk, _ = _make_backend({"x.txt": b"data"})
    await tar([_spec("x.txt")],
              read_bytes=rb,
              write_bytes=wb,
              mkdir_fn=mk,
              c=True,
              f=_spec("a.tar"))
    _, io_res = await tar([],
                          read_bytes=rb,
                          write_bytes=wb,
                          mkdir_fn=mk,
                          x=True,
                          f=_spec("a.tar"),
                          C=_spec("/out"))
    assert any("x.txt" in p for p in io_res.writes)


@pytest.mark.asyncio
async def test_tar_requires_mode():
    rb, wb, _, mk, _ = _make_backend({})
    with pytest.raises(ValueError, match="-c, -x, or -t"):
        await tar([], read_bytes=rb, write_bytes=wb, mkdir_fn=mk)


@pytest.mark.asyncio
async def test_tar_requires_f():
    rb, wb, _, mk, _ = _make_backend({"a.txt": b"x"})
    with pytest.raises(ValueError, match="-f is required"):
        await tar([_spec("a.txt")],
                  read_bytes=rb,
                  write_bytes=wb,
                  mkdir_fn=mk,
                  c=True)


@pytest.mark.asyncio
async def test_diff_identical_files():
    rb, _, _, _, _ = _make_backend({"a": b"hello\n", "b": b"hello\n"})

    async def rd(accessor, path, index=None):
        return []

    out, io_res = await diff([_spec("a"), _spec("b")],
                             read_bytes=rb,
                             readdir_fn=rd)
    assert out == b""
    assert io_res.exit_code == 0


@pytest.mark.asyncio
async def test_diff_quiet_differ():
    rb, _, _, _, _ = _make_backend({"a": b"x\n", "b": b"y\n"})

    async def rd(accessor, path, index=None):
        return []

    out, io_res = await diff([_spec("a"), _spec("b")],
                             read_bytes=rb,
                             readdir_fn=rd,
                             q=True)
    assert b"differ" in out
    assert io_res.exit_code == 1


@pytest.mark.asyncio
async def test_diff_unified():
    rb, _, _, _, _ = _make_backend({
        "a": b"hello\nworld\n",
        "b": b"hello\nuniverse\n"
    })

    async def rd(accessor, path, index=None):
        return []

    out, _ = await diff([_spec("a"), _spec("b")],
                        read_bytes=rb,
                        readdir_fn=rd,
                        u=True)
    assert b"-world" in out
    assert b"+universe" in out


@pytest.mark.asyncio
async def test_diff_too_few_paths():
    rb, _, _, _, _ = _make_backend({"a": b"x\n"})

    async def rd(accessor, path, index=None):
        return []

    with pytest.raises(ValueError, match="two paths"):
        await diff([_spec("a")], read_bytes=rb, readdir_fn=rd)


@pytest.mark.asyncio
async def test_patch_apply():
    diff_text = (b"--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n"
                 b" hello\n-world\n+universe\n")
    rb, wb, _, _, store = _make_backend({"/hello.txt": b"hello\nworld\n"})
    _, io_res = await patch([],
                            read_bytes=rb,
                            write_bytes=wb,
                            has_resource=True,
                            stdin=diff_text,
                            p="1")
    assert b"universe" in store["/hello.txt"]
    assert "/hello.txt" in io_res.writes


@pytest.mark.asyncio
async def test_patch_reverse():
    diff_text = (b"--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n"
                 b" hello\n-world\n+universe\n")
    rb, wb, _, _, store = _make_backend({"/x.txt": b"hello\nuniverse\n"})
    await patch([],
                read_bytes=rb,
                write_bytes=wb,
                has_resource=True,
                stdin=diff_text,
                R=True,
                p="1")
    assert b"world" in store["/x.txt"]


@pytest.mark.asyncio
async def test_patch_missing_input():
    rb, wb, _, _, store = _make_backend({})
    out, io = await patch([],
                          read_bytes=rb,
                          write_bytes=wb,
                          has_resource=False)
    assert out is None
    assert io.exit_code == 0
    assert not store
