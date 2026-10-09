# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import asyncio
import errno
from types import MappingProxyType

import pytest

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.backends import commands_for
from mirage.commands.config import ExecContext, command
from mirage.commands.spec import CommandSpec
from mirage.commands.spec.types import Option
from mirage.errors.types import OperationNotSupportedError
from mirage.io.types import IOResult, materialize
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.mount import MountEntry


def _run(coro):
    return asyncio.run(coro)


# ── prefix validation ──────────────────────────


def test_mount_accepts_root_prefix():
    m = MountEntry("/", RAMVFS())
    assert m.prefix == "/"


def test_mount_rejects_no_leading_slash():
    with pytest.raises(ValueError, match="must start with /"):
        MountEntry("data/", RAMVFS())


def test_mount_rejects_no_trailing_slash():
    with pytest.raises(ValueError, match="must end with /"):
        MountEntry("/data", RAMVFS())


def test_mount_rejects_double_slash():
    with pytest.raises(ValueError, match="must not contain //"):
        MountEntry("/data//sub/", RAMVFS())


def test_mount_valid_prefix():
    m = MountEntry("/data/", RAMVFS())
    assert m.prefix == "/data/"


class MisnamedRenderer(RAMVFS):
    renderers = MappingProxyType({".doc": "render_doc"})


def test_mount_rejects_a_renderer_that_names_no_method():
    with pytest.raises(TypeError, match="'render_doc', which is not a method"):
        MountEntry("/data/", MisnamedRenderer())


# ── read-only enforcement ──────────────────────


@pytest.mark.asyncio
async def test_read_only_blocks_write_cmd():
    reg = MountRegistry()
    reg.mount("/ro/", RAMVFS(), MountMode.READ)
    mount = reg.mount_for("/ro/file.txt")
    scope = PathSpec(
        vfs_path="ro/newdir",
        virtual="/ro/newdir",
        directory="/ro/",
        resolved=True,
    )
    stdout, io = await mount.run_command("mkdir", [scope], [], {})
    await materialize(stdout)
    assert io.exit_code != 0
    assert io.stderr == (
        b"mkdir: cannot create directory '/ro/newdir': Read-only file system\n"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
@pytest.mark.parametrize("declared", [False, True])
@pytest.mark.parametrize("flag", ["help", "version"])
async def test_only_wrapper_responses_bypass_the_write_guard(
    mode, declared, flag
):
    vfs = RAMVFS()
    mount = MountEntry("/ram/", vfs, mode)
    calls: list[str] = []
    options = (Option(long="--version", type="bool"),) if declared else ()

    @command(
        "mutate", vfs="ram", spec=CommandSpec(options=options), write=True
    )
    async def mutate(accessor: RAMAccessor, paths, texts, opts):
        calls.append("handler")
        accessor.store.files["/changed"] = b"changed"
        return b"custom version\n", IOResult()

    mount.register_commands([mutate])
    stdout, io = await mount.run_command("mutate", [], [], {flag: True})
    output = await materialize(stdout)
    if declared and flag == "version":
        if mode == MountMode.READ:
            assert io.exit_code == 1
            assert io.stderr == b"mutate: read-only mount at /ram/\n"
            assert not calls
            assert "/changed" not in vfs.accessor.store.files
        else:
            assert io.exit_code == 0
            assert output == b"custom version\n"
            assert calls == ["handler"]
            assert vfs.accessor.store.files["/changed"] == b"changed"
    else:
        assert io.exit_code == 0
        assert output
        assert not calls
        assert "/changed" not in vfs.accessor.store.files


@pytest.mark.asyncio
async def test_the_read_only_refusal_is_newline_terminated():
    # stderr accumulates across a line, so an unterminated refusal ran
    # into the next one: `{ sync /ro/a; sync /ro/b; }` printed the single
    # line `sync: read-only mount at /ro/sync: read-only mount at /ro/`.
    mount = MountEntry("/ro/", RAMVFS(), MountMode.READ)

    @command("sync", vfs="ram", spec=CommandSpec(), write=True)
    async def sync(accessor: RAMAccessor, paths, texts, opts):
        return None, IOResult()

    mount.register_commands([sync])
    _, io = await mount.run_command("sync", [], [], {})
    assert io.stderr == b"sync: read-only mount at /ro/\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
@pytest.mark.parametrize("path_guarded", [False, True])
async def test_only_a_write_command_the_dispatcher_cannot_see_is_refused_up_front(
    mode, path_guarded
):
    # A path-guarded command's writes go through the guarded op slots,
    # which refuse each one where it happens, so a read-only mount runs
    # it like a reader (`gzip -c`, `split -n 1/2`). A write command that
    # reaches its service some other way has no gate to refuse it, so
    # the mount refuses it before it runs.
    vfs = RAMVFS()
    mount = MountEntry("/ram/", vfs, mode)
    calls: list[int] = []

    @command(
        "filter",
        vfs="ram",
        spec=CommandSpec(),
        write=True,
        path_guarded=path_guarded,
    )
    async def filter_cmd(accessor: RAMAccessor, paths, texts, opts):
        calls.append(len(paths))
        return b"ran\n", IOResult()

    mount.register_commands([filter_cmd])
    paths = [PathSpec.from_str_path("/ram/a")]
    stdout, io = await mount.run_command("filter", paths, [], {})
    if mode == MountMode.READ and not path_guarded:
        assert io.exit_code == 1
        assert io.stderr == b"filter: read-only mount at /ram/\n"
        assert not calls
    else:
        assert io.exit_code == 0
        assert await materialize(stdout) == b"ran\n"
        assert calls == [1]


async def _stat_tally(p: str | PathSpec) -> FileStat:
    name = p if isinstance(p, str) else p.virtual
    if name.endswith("dir.tally"):
        return FileStat(name=name, type=FileType.DIRECTORY)
    return FileStat(name=name, type=FileType.FILE, size=4)


@pytest.mark.asyncio
async def test_a_directory_does_not_route_to_a_filetype_handler():
    # A filetype handler is chosen from the operand's NAME, and a
    # directory can carry any extension, so without a type check `cat`
    # on a directory named `dir.tally` runs the renderer, which reads
    # bytes that are not there and reports ENOENT: registering a
    # renderer made the command worse than the built-in it replaced.
    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    fired: list[str] = []
    builtins: list[str] = []

    @command("cat", vfs="ram", spec=CommandSpec())
    async def plain(accessor: RAMAccessor, paths, texts, opts):
        builtins.append(paths[0].virtual)
        return None, IOResult()

    @command("cat", vfs="ram", spec=CommandSpec(), filetype=".tally")
    async def typed(accessor: RAMAccessor, paths, texts, opts):
        fired.append(paths[0].virtual)
        return b"rendered\n", IOResult()

    mount.register_commands([plain, typed])
    context = ExecContext(stat_path=_stat_tally)
    await mount.run_command(
        "cat", [PathSpec.from_str_path("/dir.tally")], [], {}, context
    )
    assert fired == []
    assert builtins == ["/dir.tally"]

    await mount.run_command(
        "cat", [PathSpec.from_str_path("/file.tally")], [], {}, context
    )
    assert fired == ["/file.tally"]


def test_write_mode_allows_write_cmd():
    reg = MountRegistry()
    reg.mount("/rw/", RAMVFS(), MountMode.WRITE)
    mount = reg.mount_for("/rw/file.txt")
    scope = PathSpec(
        vfs_path="rw/newdir",
        virtual="/rw/newdir",
        directory="/rw/",
        resolved=True,
    )
    stdout, io = _run(mount.run_command("mkdir", [scope], [], {}))
    assert io.exit_code == 0


def test_read_only_allows_read_cmd():
    reg = MountRegistry()
    reg.mount("/ro/", RAMVFS(), MountMode.READ)
    mount = reg.mount_for("/ro/")
    scope = PathSpec(
        vfs_path="ro", virtual="/ro/", directory="/ro/", resolved=False
    )
    stdout, io = _run(mount.run_command("ls", [scope], [], {}))
    assert io.exit_code == 0


# ── run_command ────────────────────────────────


def test_execute_cmd_cat(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(
        vfs_path="data/hello.txt",
        virtual="/data/hello.txt",
        directory="/data/",
        resolved=True,
    )
    stdout, io = _run(mount.run_command("cat", [scope], [], {}))
    assert io.exit_code == 0
    assert stdout is not None


def test_execute_cmd_not_found(registry):
    mount = registry.mount_for("/data/hello.txt")
    stdout, io = _run(mount.run_command("nonexistent_cmd", [], [], {}))
    assert io.exit_code == 127
    assert b"command not found" in io.stderr


def test_execute_cmd_ls(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(
        vfs_path="data", virtual="/data/", directory="/data/", resolved=False
    )
    stdout, io = _run(mount.run_command("ls", [scope], [], {}))
    assert io.exit_code == 0


def test_execute_cmd_with_flag_kwargs(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(
        vfs_path="data/hello.txt",
        virtual="/data/hello.txt",
        directory="/data/",
        resolved=True,
    )
    stdout, io = _run(mount.run_command("cat", [scope], [], {"n": True}))
    assert io.exit_code == 0


@pytest.mark.asyncio
async def test_execute_cmd_with_texts(registry):
    mount = registry.mount_for("/data/hello.txt")
    scope = PathSpec(
        vfs_path="data/hello.txt",
        virtual="/data/hello.txt",
        directory="/data/",
        resolved=True,
    )
    stdout, io = await mount.run_command("grep", [scope], ["hello"], {})
    assert b"hello" in await materialize(stdout)
    assert io.exit_code == 0


# ── call ─────────────────────────────────


def test_execute_op_stat(registry):
    mount = registry.mount_for("/data/hello.txt")
    result = _run(mount.call("stat", "/hello.txt"))
    assert result is not None
    assert result.size > 0


def test_execute_op_readdir(registry):
    mount = registry.mount_for("/data/")
    result = _run(mount.call("readdir", "/"))
    assert isinstance(result, list)
    assert len(result) > 0


def test_execute_op_no_such_op(registry):
    mount = registry.mount_for("/data/hello.txt")
    with pytest.raises(OperationNotSupportedError, match="no op") as exc_info:
        _run(mount.call("nonexistent_op", "/file.txt"))
    assert exc_info.value.filename == "/file.txt"
    assert exc_info.value.errno == errno.ENOTSUP


# ── command resolution ─────────────────────────


def test_resolve_command_exists(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("cat")
    assert cmd is not None
    assert cmd.name == "cat"


def test_resolve_command_missing(registry):
    mount = registry.mount_for("/data/hello.txt")
    cmd = mount.resolve_command("nonexistent")
    assert cmd is None


@pytest.mark.asyncio
async def test_a_path_guarded_command_is_still_held_at_its_write():
    vfs = RAMVFS()
    vfs._store.files["/a"] = b"original"
    mount = MountEntry("/ram/", vfs, MountMode.READ)
    cmd = next(cmd for cmd in commands_for(vfs) if cmd.name == "gzip")
    assert cmd.path_guarded
    mount.register(cmd)
    # The write is refused where it happens and gzip says so in its own
    # words (the fatal write_error form), leaving the store untouched.
    stdout, io = await mount.run_command(
        "gzip", [PathSpec.from_str_path("/ram/a")], [], {}
    )
    await materialize(stdout)
    assert (io.exit_code, io.stderr) == (
        1,
        b"\ngzip: /ram/a.gz: Read-only file system\n",
    )
    assert vfs._store.files == {"/a": b"original"}


@pytest.mark.asyncio
async def test_closing_command_output_finalizes_its_source():
    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    io = IOResult(exit_code=1)

    @command("streaming", vfs="ram", spec=CommandSpec())
    async def streaming(accessor: RAMAccessor, paths, texts, opts):
        async def source():
            try:
                yield b"first\n"
                yield b"second\n"
            finally:
                io.exit_code = 0
                io.stderr = b"finished\n"

        return source(), io

    mount.register_commands([streaming])
    output, result = await mount.run_command("streaming", [], [], {})
    assert await anext(output) == b"first\n"
    await output.aclose()
    assert result.exit_code == 0
    assert result.stderr == b"finished\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("started", [False, True])
async def test_native_output_close_joins_producer_and_releases_mount(started):
    closed = asyncio.Event()

    @command("writer", vfs="ram", spec=CommandSpec())
    async def writer(accessor, paths, texts, opts):
        return _HeldSource(b"prefix", closed.set), IOResult()

    mount = MountEntry("/", RAMVFS(), MountMode.WRITE)
    mount.register_commands([writer])
    output, _ = await mount.run_command("writer", [], [], {})
    if started:
        assert await anext(output) == b"prefix"
    await asyncio.wait_for(output.aclose(), 1)
    assert closed.is_set()
    await asyncio.wait_for(mount.activity.wait(), 1)


class _HeldSource:
    """Yields its bytes once, then waits until it is closed, once."""

    def __init__(self, data, on_close):
        self._data = data
        self._on_close = on_close

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._data:
            data, self._data = self._data, b""
            return data
        await asyncio.Event().wait()

    async def aclose(self):
        if self._on_close is not None:
            self._on_close()
            self._on_close = None
