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

import pytest

from mirage import MountMode, Workspace
from mirage.accessor.base import Accessor
from mirage.accessor.ram import RAMAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.commands.cli import CLI, CLIHandler
from mirage.commands.config import command
from mirage.commands.spec import Argument, CommandSpec
from mirage.commands.spec.types import FlagValue
from mirage.io.types import IOResult
from mirage.runtime.files import RuntimeFiles
from mirage.types import (
    CapacityState,
    ContentType,
    FileStat,
    FileType,
    PathSpec,
    ReadPolicy,
    ReadSpec,
)
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from mirage.workspace.mount import MountEntry
from mirage.workspace.mount.read_policy import check_read_capability
from tests.fixtures.driver_ops import ops
from tests.fixtures.vfs_io import served

PAGES = {
    "guides": {
        "quickstart.md": "# Quickstart\nHello.\n",
    },
    "notes.md": "agents speak bash\n",
}


class ClosingAccessor(Accessor):
    def __init__(self) -> None:
        self.close_calls = 0

    async def close(self) -> None:
        self.close_calls += 1


class WikiAccessor(Accessor):
    def __init__(self, pages: dict) -> None:
        self.pages = pages


def _node(pages: dict, key: str):
    node = pages
    for part in [p for p in key.split("/") if p]:
        if not isinstance(node, dict) or part not in node:
            raise FileNotFoundError(key)
        node = node[part]
    return node


async def readdir(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> list[str]:
    node = _node(accessor.pages, path.vfs_path)
    if not isinstance(node, dict):
        raise NotADirectoryError(path.virtual)
    parent = path.virtual.rstrip("/")
    return [
        f"{parent}/{name}" + ("/" if isinstance(child, dict) else "")
        for name, child in node.items()
    ]


async def read_bytes(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> bytes:
    node = _node(accessor.pages, path.vfs_path)
    if isinstance(node, dict):
        raise IsADirectoryError(path.virtual)
    return node.encode()


async def stat(
    accessor: WikiAccessor,
    path: PathSpec,
    index: IndexCacheStore = NULL_INDEX,
) -> FileStat:
    node = _node(accessor.pages, path.vfs_path)
    name = path.virtual.rstrip("/").rsplit("/", 1)[-1] or "/"
    if isinstance(node, dict):
        return FileStat(name=name, size=None, type=FileType.DIRECTORY)
    return FileStat(
        name=name,
        size=len(node.encode()),
        type=FileType.FILE,
        content=ContentType.TEXT,
    )


@command("wiki_hello", vfs="wiki", spec=CommandSpec())
async def wiki_hello(accessor, *texts: str, **flags: FlagValue):
    return b"hello custom verb\n", IOResult()


class WikiVFS(BaseVFS):
    """A plug-in VFS over a dict of pages: the three required reads."""

    name = "wiki"

    async def readdir(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> list[str]:
        return await readdir(self.accessor, path, index)

    async def read(
        self,
        path: PathSpec,
        index: IndexCacheStore = NULL_INDEX,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await read_bytes(self.accessor, path, index)
        return data[offset : None if size is None else offset + size]

    async def stat(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> FileStat:
        return await stat(self.accessor, path, index)


def make_vfs(**kwargs) -> BaseVFS:
    return WikiVFS(accessor=WikiAccessor(PAGES), **kwargs)


def ram_without(store: RAMStore, *names: str, name: str = "custom") -> RAMVFS:
    """A RAM VFS over ``store`` that does not define ``names``.

    Args:
        store (RAMStore): the store to serve.
        *names (str): the functions to leave undefined.
        name (str): the VFS name.
    """
    cls = type(
        "Custom",
        (RAMVFS,),
        {"name": name, **{n: getattr(BaseVFS, n) for n in names}},
    )
    vfs = cls()
    vfs._store = store
    vfs.accessor = RAMAccessor(store)
    return vfs


def command_names(vfs: BaseVFS) -> set[str]:
    ws = Workspace({"/wiki/": vfs}, mode=MountMode.READ)
    mount = ws._registry.mount_for("/wiki/a")
    return {rc.name for rc in mount.all_commands()}


class Marker:
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.marked = True


class Mixed(BaseVFS, Marker):
    pass


def test_init_is_cooperative():
    assert Mixed().marked is True


def test_missing_accessor_attribute_raises():
    with pytest.raises(AttributeError):
        Accessor().missing_operation


def test_base_serves_nothing():
    vfs = BaseVFS()
    assert served(vfs) == set()
    assert vfs.commands() == []


def test_a_driver_that_brings_no_accessor_runs_over_the_default():
    # TypeScript's twin defaults to a no-op accessor the same way, so
    # neither language's mount branches on an absent one.
    assert isinstance(BaseVFS().accessor, Accessor)


def test_a_driver_keeps_the_accessor_it_was_handed():
    accessor = WikiAccessor(PAGES)
    assert WikiVFS(accessor=accessor).accessor is accessor


def test_base_has_no_storage_location():
    assert BaseVFS().storage_location() is None


@pytest.mark.asyncio
async def test_base_capacity_is_unknown():
    cap = await BaseVFS().capacity()
    assert cap.state == CapacityState.UNKNOWN


def test_base_has_no_delta_hook():
    assert BaseVFS().delta_hook() is None


def test_base_state_asks_to_be_handed_back():
    vfs = BaseVFS()
    assert vfs.get_state() == {"type": "base", "needs_override": True}
    vfs.load_state({"type": "base"})


@pytest.mark.asyncio
async def test_close_releases_accessor_once():
    vfs = BaseVFS()
    accessor = ClosingAccessor()
    vfs.accessor = accessor

    assert not vfs.is_closed
    await vfs.close()
    await vfs.close()

    assert accessor.close_calls == 1
    assert vfs.is_closed


def test_generic_commands_registered():
    names = command_names(make_vfs())
    assert {"ls", "cat", "grep", "find", "head", "wc"} <= names


def test_write_commands_register_without_write_op():
    # Their read-only modes (`tee` with no operand, `gzip -c`) run on a
    # backend without writes; a line that writes answers ENOTSUP there.
    names = command_names(make_vfs())
    assert {"tee", "rm", "gzip", "tar"} <= names


@command("grep", vfs="wiki", spec=CommandSpec())
async def wiki_grep(accessor, paths, texts, opts):
    return b"", IOResult()


def test_a_handed_command_wins_over_the_generic():
    ws = Workspace(
        {"/wiki/": make_vfs(commands=[wiki_grep])}, mode=MountMode.READ
    )
    mount = ws._registry.mount_for("/wiki/a")
    assert mount.resolve_command("grep").fn is wiki_grep
    assert mount.resolve_command("rg") is not None


def test_extra_commands_registered():
    names = command_names(make_vfs(commands=[wiki_hello]))
    assert "wiki_hello" in names


def test_requires_name():
    with pytest.raises(ValueError):
        WikiVFS(name="", accessor=WikiAccessor(PAGES))


def test_plugin_state_asks_to_be_handed_back():
    assert make_vfs().get_state() == {
        "type": "wiki",
        "needs_override": True,
    }


def test_declaration_flags_forwarded():
    vfs = make_vfs(
        sizes_always_known=True,
        supports_snapshot=True,
        read_revalidatable=True,
    )
    assert vfs.sizes_always_known is True
    assert vfs.supports_snapshot is True
    assert vfs.read_revalidatable is True


def test_declaration_flags_default_off():
    vfs = make_vfs()
    assert vfs.sizes_always_known is False
    assert vfs.supports_snapshot is False
    assert vfs.read_revalidatable is False


def test_prompts_set():
    vfs = make_vfs(prompt="wiki files", write_prompt="writable")
    assert vfs.prompt == "wiki files"
    assert vfs.write_prompt == "writable"


@pytest.mark.asyncio
async def test_glob_walks_readdir():
    mount = MountEntry("/", make_vfs())
    spec = PathSpec(
        vfs_path="guides/quick*",
        virtual="/guides/quick*",
        directory="/guides",
        pattern="quick*",
        resolved=False,
    )
    matches = await mount.expand_glob([spec], "")
    assert [m.virtual for m in matches] == ["/guides/quickstart.md"]


@pytest.mark.asyncio
async def test_workspace_execution_end_to_end():
    ws = Workspace(
        {"/wiki/": make_vfs(commands=[wiki_hello])}, mode=MountMode.READ
    )

    result = await ws.shell("ls /wiki/guides")
    assert "quickstart.md" in await result.stdout_str()

    result = await ws.shell("cat /wiki/notes.md")
    assert await result.stdout_str() == "agents speak bash\n"

    result = await ws.shell("grep -r Quickstart /wiki/")
    assert "/wiki/guides/quickstart.md:# Quickstart" in (
        await result.stdout_str()
    )

    result = await ws.shell("find /wiki -name '*.md'")
    out = await result.stdout_str()
    assert "/wiki/guides/quickstart.md" in out
    assert "/wiki/notes.md" in out

    result = await ws.shell("wiki_hello")
    assert await result.stdout_str() == "hello custom verb\n"

    # The derived ops serve the VFS surface too, not just the commands.
    assert "/wiki/guides/quickstart.md" in await ws.readdir("/wiki/guides")
    assert (await ws.stat("/wiki/notes.md")).size == 18


def test_a_plugin_serves_its_reads_at_the_dispatcher():
    assert served(make_vfs()) == {"glob", "read", "readdir", "stat"}


def test_a_script_registered_vfs_is_named_in_the_read_refusal():
    """`vfs.name` is a plain string here, not a `VFSName`.

    ``str()`` of the enum renders its repr, so the refusal builds the
    name through a getattr fallback; only a script-registered backend
    exercises the other side of it.
    """
    vfs = make_vfs(caches_reads=True)
    assert vfs.read_revalidatable is False
    with pytest.raises(ValueError) as exc:
        check_read_capability("/w/", vfs, ReadSpec(policy=ReadPolicy.FRESH))
    assert "wiki does not" in str(exc.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["-r", "-rv", "-rf", "-d"])
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
async def test_missing_directory_removal_continues_to_later_operands(
    flag, mode
):
    store = RAMStore()
    store.dirs.add("/empty")
    store.files["/file"] = b"keep"
    vfs = ram_without(store, "rm_r", "rmdir")
    ws = Workspace({"/custom": (vfs, mode)})
    try:
        result = await ws.shell(f"rm {flag} /custom/empty /custom/file")
        reason = (
            "Read-only file system"
            if mode == MountMode.READ
            else "Operation not supported"
        )
        expected = f"rm: cannot remove '/custom/empty': {reason}\n"
        if mode == MountMode.READ:
            expected += (
                "rm: cannot remove '/custom/file': Read-only file system\n"
            )
        assert result.exit_code == 1
        assert result.stderr.decode() == expected
        assert "/empty" in store.dirs
        assert ("/file" in store.files) == (mode == MountMode.READ)
        assert await result.stdout_str() == (
            "removed '/custom/file'\n"
            if flag == "-rv" and mode == MountMode.WRITE
            else ""
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("flags", ["-r", "-rv", "-r --update=all", "-r -n"])
async def test_custom_vfs_copies_without_native_copy(flags):
    store = RAMStore()
    store.dirs.update({"/src", "/src/empty", "/src/sub"})
    store.files["/src/sub/file"] = b"payload"
    vfs = ram_without(store, "copy", "find")
    ws = Workspace({"/custom": vfs}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(f"cp {flags} /custom/src /custom/dst")
        assert (result.exit_code, result.stderr or b"") == (0, b"")
        assert store.files["/dst/sub/file"] == b"payload"
        assert {"/dst", "/dst/empty", "/dst/sub"} <= store.dirs
        result = await ws.shell("cp /custom/src/sub/file /custom/plain")
        assert (result.exit_code, result.stderr or b"") == (0, b"")
        assert store.files["/plain"] == b"payload"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags", ["-r", "-r --update=older", "-r -n", "-r --backup"]
)
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
async def test_unavailable_copy_does_not_create_directories(flags, mode):
    store = RAMStore()
    store.dirs.update({"/src", "/src/empty"})
    store.files["/src/file"] = b"payload"
    before = set(store.dirs)
    vfs = ram_without(store, "copy", "write")
    ws = Workspace({"/custom": (vfs, mode)})
    try:
        result = await ws.shell(f"cp {flags} /custom/src /custom/dst")
        reason = (
            "Read-only file system"
            if mode == MountMode.READ
            else "Operation not supported"
        )
        assert result.exit_code == 1
        assert (
            result.stderr.decode()
            == f"cp: cannot create directory '/custom/dst': {reason}\n"
        )
        assert store.dirs == before
        assert store.files == {"/src/file": b"payload"}
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("custom", [False, True])
async def test_builtin_and_custom_writes_obey_mount_mode(custom):
    builtin = RAMVFS()
    path = PathSpec(virtual="/data/a", directory="/data", vfs_path="a")
    await ops(builtin).write(path, b"before")
    vfs = ram_without(builtin._store, name="probe") if custom else builtin
    ws = Workspace({"/data": vfs}, mode=MountMode.READ)
    try:
        result = await ws.shell("echo after > /data/a")
        assert result.exit_code != 0
        assert await ops(vfs).read(path) == b"before"
    finally:
        await ws.close()
        if custom:
            await builtin.close()


async def _read_cli(inv):
    assert inv.view is not None and inv.view.dispatch is not None
    return await inv.view.dispatch("read", inv.paths[0])


@pytest.mark.asyncio
async def test_custom_driver_serves_cli_namespace_and_runtime():
    ws = Workspace({"/wiki": make_vfs()}, mode=MountMode.WRITE)
    ws.register_cli(
        "showpage",
        CLI(
            spec=CommandSpec(
                name="showpage", arguments=(Argument("path", type="path"),)
            ),
            handlers={"": CLIHandler(fn=_read_cli)},
        ),
    )
    try:
        linked = await ws.shell("ln -s /wiki/notes.md /page")
        assert linked.exit_code == 0
        for line in ("cat /page", "showpage /page"):
            result = await ws.shell(line)
            assert (result.exit_code, result.stdout) == (
                0,
                b"agents speak bash\n",
            )
        runtime = RuntimeFiles(ws.dispatch, asyncio.get_running_loop())
        assert (
            await asyncio.to_thread(runtime.read, "/page")
            == b"agents speak bash\n"
        )
        row = await asyncio.to_thread(runtime.stat, "/page")
        assert row.size == 18
        assert not row.is_dir
    finally:
        await ws.close()
