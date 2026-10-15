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

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.cache.index.scope import command_scope
from mirage.types import DirListing, FileStat, FileType, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.workspace import Workspace
from mirage.workspace.mount.listing import (
    beyond_window,
    entry_at,
    index_key,
    keep_listing,
    stored_listing,
    stored_stat,
    stored_tree,
)


class Folders(BaseVFS):
    """A store that knows its entries only by id, as Drive does."""

    name = "folders"

    def __init__(self) -> None:
        super().__init__()
        self.nodes: dict[str, dict] = {
            "root": {"name": "", "parent": None, "dir": True, "data": b""}
        }
        self.calls: list[tuple[str, str]] = []
        self._ids = 0

    def add(self, name: str, parent: str = "root", data: bytes | None = None):
        self._ids += 1
        node_id = f"n{self._ids}"
        self.nodes[node_id] = {
            "name": name,
            "parent": parent,
            "dir": data is None,
            "data": data or b"",
        }
        return node_id

    def stat_of(self, node_id: str) -> FileStat:
        node = self.nodes[node_id]
        return FileStat(
            name=node["name"],
            type=FileType.DIRECTORY if node["dir"] else FileType.FILE,
            size=None if node["dir"] else len(node["data"]),
            extra={"id": node_id},
        )

    def _folder(self, path: PathSpec, parent: FileStat | None) -> str:
        if parent is not None:
            return parent.extra["id"]
        if "/" in path.vfs_path.strip("/"):
            raise FileNotFoundError(path.virtual)
        return "root"

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat]:
        if entry is None and path.vfs_path.strip("/"):
            raise FileNotFoundError(path.virtual)
        folder = "root" if entry is None else entry.extra["id"]
        self.calls.append(("list", folder))
        if folder not in self.nodes:
            raise FileNotFoundError(path.virtual)
        return [
            self.stat_of(node_id)
            for node_id, node in self.nodes.items()
            if node["parent"] == folder
        ]

    async def stat(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> FileStat:
        if not path.vfs_path.strip("/"):
            return FileStat(name="/", type=FileType.DIRECTORY)
        if entry is None or entry.extra["id"] not in self.nodes:
            raise FileNotFoundError(path.virtual)
        self.calls.append(("stat", entry.extra["id"]))
        return self.stat_of(entry.extra["id"])

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> bytes:
        if entry is None or entry.extra["id"] not in self.nodes:
            raise FileNotFoundError(path.virtual)
        self.calls.append(("read", entry.extra["id"]))
        return self.nodes[entry.extra["id"]]["data"]

    async def write(
        self,
        path: PathSpec,
        data: bytes,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        if entry is not None:
            self.calls.append(("update", entry.extra["id"]))
            self.nodes[entry.extra["id"]]["data"] = data
            return self.stat_of(entry.extra["id"])
        folder = self._folder(path, parent)
        self.calls.append(("write", folder))
        name = path.vfs_path.strip("/").rsplit("/", 1)[-1]
        return self.stat_of(self.add(name, folder, data))

    async def mkdir(
        self,
        path: PathSpec,
        parents: bool = False,
        parent: FileStat | None = None,
    ) -> FileStat:
        folder = self._folder(path, parent)
        self.calls.append(("mkdir", folder))
        name = path.vfs_path.strip("/").rsplit("/", 1)[-1]
        return self.stat_of(self.add(name, folder))

    async def read_tree(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> dict[str, FileStat] | None:
        root = "root" if entry is None else entry.extra["id"]
        self.calls.append(("tree", root))
        found = {"": self.stat_of(root)}
        pending = [(root, "")]
        while pending:
            folder, base = pending.pop()
            for node_id, node in self.nodes.items():
                if node["parent"] != folder:
                    continue
                relative = f"{base}/{node['name']}" if base else node["name"]
                found[relative] = self.stat_of(node_id)
                if node["dir"]:
                    pending.append((node_id, relative))
        return found

    async def unlink(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> None:
        if entry is None or entry.extra["id"] not in self.nodes:
            raise FileNotFoundError(path.virtual)
        self.calls.append(("unlink", entry.extra["id"]))
        del self.nodes[entry.extra["id"]]

    async def rename(
        self,
        src: PathSpec,
        dst: PathSpec,
        entry: FileStat | None = None,
        dst_parent: FileStat | None = None,
        dst_entry: FileStat | None = None,
    ) -> FileStat:
        if entry is None:
            raise FileNotFoundError(src.virtual)
        moved = entry.extra["id"]
        self.calls.append(
            (
                "rename",
                f"{moved}>{self._folder(dst, dst_parent)}"
                f"{'' if dst_entry is None else '!' + dst_entry.extra['id']}",
            )
        )
        if dst_entry is not None:
            del self.nodes[dst_entry.extra["id"]]
        node = self.nodes[moved]
        node["parent"] = self._folder(dst, dst_parent)
        node["name"] = dst.vfs_path.strip("/").rsplit("/", 1)[-1]
        return self.stat_of(moved)


def _workspace(store: Folders) -> Workspace:
    return Workspace({"/f/": (store, MountMode.WRITE)}, mode=MountMode.WRITE)


def _at(path: str) -> PathSpec:
    return PathSpec.from_str_path(path)


@pytest.mark.asyncio
async def test_a_listing_answers_the_stats_after_it():
    async with command_scope():
        store = Folders()
        store.add("a.txt", data=b"hi")
        store.add("d")
        ws = _workspace(store)
        listed, _ = await ws.dispatch("readdir", _at("/f"))
        assert sorted(listed) == ["/f/a.txt", "/f/d"]
        row, _ = await ws.dispatch("stat", _at("/f/a.txt"))
        assert (row.name, row.size) == ("a.txt", 2)
        with pytest.raises(FileNotFoundError):
            await ws.dispatch("stat", _at("/f/gone.txt"))
        assert store.calls == [("list", "root")]


@pytest.mark.asyncio
async def test_a_cold_read_lists_its_parent_and_reads_by_id():
    store = Folders()
    d = store.add("d")
    f = store.add("f.txt", d, b"deep")
    ws = _workspace(store)
    data, _ = await ws.dispatch("read", _at("/f/d/f.txt"))
    assert data == b"deep"
    assert store.calls == [("list", "root"), ("list", d), ("read", f)]


@pytest.mark.asyncio
async def test_a_nested_create_hands_each_level_the_one_above():
    async with command_scope():
        store = Folders()
        ws = _workspace(store)
        await ws.dispatch("mkdir", _at("/f/a/b/c"), parents=True)
        by_name = {
            node["name"]: (node_id, node)
            for node_id, node in store.nodes.items()
        }
        assert by_name["a"][1]["parent"] == "root"
        assert by_name["b"][1]["parent"] == by_name["a"][0]
        assert by_name["c"][1]["parent"] == by_name["b"][0]
        assert store.calls == [
            ("list", "root"),
            ("mkdir", "root"),
            ("mkdir", by_name["a"][0]),
            ("mkdir", by_name["b"][0]),
        ]
        await ws.dispatch("write", _at("/f/a/b/c/x.txt"), data=b"x")
        assert store.nodes[f"n{store._ids}"]["parent"] == by_name["c"][0]
        listed, _ = await ws.dispatch("readdir", _at("/f/a/b/c"))
        assert listed == ["/f/a/b/c/x.txt"]
        assert store.calls[-1] == ("write", by_name["c"][0])


@pytest.mark.asyncio
async def test_a_listing_kept_through_a_create_needs_no_second_request():
    async with command_scope():
        store = Folders()
        store.add("old.txt", data=b"o")
        ws = _workspace(store)
        await ws.dispatch("readdir", _at("/f"))
        await ws.dispatch("write", _at("/f/new.txt"), data=b"n")
        listed, _ = await ws.dispatch("readdir", _at("/f"))
        assert sorted(listed) == ["/f/new.txt", "/f/old.txt"]
        assert [call for call in store.calls if call[0] == "list"] == [
            ("list", "root")
        ]


@pytest.mark.asyncio
async def test_a_rename_is_handed_where_it_lands_and_what_it_replaces():
    store = Folders()
    a = store.add("a.txt", data=b"a")
    d = store.add("d")
    b = store.add("b.txt", d, b"b")
    ws = _workspace(store)
    await ws.dispatch("rename", _at("/f/a.txt"), dst=_at("/f/d/b.txt"))
    assert ("rename", f"{a}>{d}!{b}") in store.calls
    assert store.nodes[a]["parent"] == d and b not in store.nodes
    await ws.dispatch("rename", _at("/f/d/b.txt"), dst=_at("/f/c.txt"))
    assert ("rename", f"{a}>root") in store.calls


@pytest.mark.asyncio
async def test_a_stale_entry_is_listed_again_once():
    store = Folders()
    old = store.add("a.txt", data=b"old")
    ws = _workspace(store)
    await ws.dispatch("readdir", _at("/f"))
    del store.nodes[old]
    new = store.add("a.txt", data=b"new")
    data, _ = await ws.dispatch("read", _at("/f/a.txt"))
    assert data == b"new"
    assert store.calls == [("list", "root"), ("list", "root"), ("read", new)]


@pytest.mark.asyncio
async def test_a_subtree_read_is_kept_and_answers_the_walk_after_it():
    store = Folders()
    d = store.add("d")
    sub = store.add("sub", d)
    store.add("f.txt", d, b"f")
    store.add("g.txt", sub, b"gg")
    ws = _workspace(store)
    tree, _ = await ws.dispatch("read_tree", _at("/f/d"))
    assert sorted(tree) == ["f.txt", "sub", "sub/g.txt"]
    assert store.calls == [("list", "root"), ("tree", d)]
    store.calls.clear()
    assert (await ws.dispatch("stat", _at("/f/d")))[0].name == "d"
    assert (await ws.dispatch("stat", _at("/f/d/sub/g.txt")))[0].size == 2
    listed, _ = await ws.dispatch("readdir", _at("/f/d/sub"))
    assert listed == ["/f/d/sub/g.txt"]
    again, _ = await ws.dispatch("read_tree", _at("/f/d"))
    assert sorted(again) == sorted(tree)
    assert store.calls == []


@pytest.mark.asyncio
async def test_a_stat_asks_the_backend_once_its_listing_expires():
    store = Folders()
    a = store.add("a.txt", data=b"a")
    ws = _workspace(store)
    with patch("mirage.cache.index.ram.datetime") as clock:
        clock.now.return_value = datetime(2026, 1, 1, tzinfo=timezone.utc)
        await ws.dispatch("readdir", _at("/f"))
        await ws.dispatch("stat", _at("/f/a.txt"))
        assert store.calls == [("list", "root")]
        clock.now.return_value += timedelta(seconds=store.index_ttl + 1)
        await ws.dispatch("stat", _at("/f/a.txt"))
    assert store.calls == [("list", "root"), ("list", "root"), ("stat", a)]


@pytest.mark.asyncio
async def test_a_kept_listing_names_its_seeds_and_leaves_a_view_partial():
    index = RAMIndexCacheStore()
    dirs = [
        FileStat(name="d", type=FileType.DIRECTORY),
        FileStat(name="v.txt", type=FileType.FILE),
    ]
    seeded = DirListing(
        dirs, seeds={"d": [FileStat(name="in.txt", type=FileType.FILE)]}
    )
    assert await keep_listing(index, "/m", seeded) == ["/m/d", "/m/v.txt"]
    assert await stored_listing(index, "/m/d") == ["/m/d/in.txt"]
    assert (await stored_stat(index, "/m/d/in.txt")).name == "in.txt"
    with pytest.raises(FileNotFoundError):
        await stored_stat(index, "/m/nope")
    view = DirListing([dirs[1]], partial=True)
    await keep_listing(index, "/p", view)
    assert await stored_listing(index, "/p") is None
    assert (await entry_at(index, "/p/v.txt", None)).name == "v.txt"
    assert await stored_stat(index, "/p/other") is None


def test_an_index_key_is_the_virtual_path_and_a_glob_keys_its_directory():
    spec = PathSpec(virtual="/m/a/b", directory="/m/a/", vfs_path="/a/b")
    assert index_key("/m/", spec) == "/m/a/b"
    root = PathSpec(virtual="/m", directory="/", vfs_path="/")
    assert index_key("/m/", root) == "/m"
    glob = PathSpec(
        virtual="/m/a/*.txt",
        directory="/m/a/",
        vfs_path="a/*.txt",
        pattern="*.txt",
    )
    assert index_key("/m/", glob) == "/m/a"


@pytest.mark.asyncio
async def test_a_window_proves_nothing_absent_and_answers_no_glob():
    index = RAMIndexCacheStore()
    day = FileStat(name="d3", type=FileType.DIRECTORY)
    await keep_listing(index, "/w", DirListing([day], window=True))
    assert await stored_listing(index, "/w") == ["/w/d3"]
    assert await stored_listing(index, "/w", glob=True) is None
    assert await stored_stat(index, "/w/d1") is None
    assert await beyond_window(index, "/w/d1")
    assert not await beyond_window(index, "/w/d3")
    assert await stored_tree(index, "/w") is None


class Days(BaseVFS):
    """A channel whose listing is a window of recent days, as Slack's is:
    a day outside it is still there when its channel is."""

    name = "days"

    def __init__(self) -> None:
        super().__init__()
        self.calls: list[str] = []

    async def readdir(
        self, path: PathSpec, entry: FileStat | None = None
    ) -> list[FileStat] | DirListing:
        key = path.vfs_path.strip("/")
        self.calls.append(f"list {key}")
        if not key:
            return [FileStat(name="chan", type=FileType.DIRECTORY)]
        if key == "chan" and path.pattern is not None:
            return DirListing(
                [
                    FileStat(name="d1", type=FileType.DIRECTORY),
                    FileStat(name="d3", type=FileType.DIRECTORY),
                ],
                window=True,
            )
        if key == "chan":
            return DirListing(
                [FileStat(name="d3", type=FileType.DIRECTORY)], window=True
            )
        raise FileNotFoundError(path.virtual)

    async def stat(
        self,
        path: PathSpec,
        entry: FileStat | None = None,
        parent: FileStat | None = None,
    ) -> FileStat:
        key = path.vfs_path.strip("/")
        self.calls.append(f"stat {key}")
        if not key:
            return FileStat(name="/", type=FileType.DIRECTORY)
        if entry is not None:
            return entry
        name = key.rsplit("/", 1)[-1]
        if parent is not None and name.startswith("d"):
            return FileStat(name=name, type=FileType.DIRECTORY)
        raise FileNotFoundError(path.virtual)


@pytest.mark.asyncio
async def test_a_name_beyond_a_window_is_the_backends_to_answer():
    store = Days()
    ws = Workspace({"/w/": (store, MountMode.READ)})
    try:
        await ws.dispatch("readdir", _at("/w/chan"))
        store.calls.clear()
        day, _ = await ws.dispatch("stat", _at("/w/chan/d1"))
        assert day.type is FileType.DIRECTORY
        # The window does not name d1, so the backend answers it, handed
        # the channel its listing names: no listing is asked again.
        assert store.calls and all(c == "stat chan/d1" for c in store.calls)
        with pytest.raises(FileNotFoundError):
            await ws.dispatch("stat", _at("/w/chan/x1"))
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_glob_past_a_window_asks_the_backend():
    store = Days()
    ws = Workspace({"/w/": (store, MountMode.READ)})
    try:
        await ws.dispatch("readdir", _at("/w/chan"))
        r = await ws.shell("echo /w/chan/d*")
        assert await r.stdout_str() == "/w/chan/d1 /w/chan/d3\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_root_stat_lists_nothing_outside_the_mount():
    store = Days()
    ws = Workspace({"/m/w/": (store, MountMode.READ)})
    try:
        root, _ = await ws.dispatch("stat", _at("/m/w"))
        assert root.type is FileType.DIRECTORY
        # The root holds itself, so the parent a stat is handed asks no
        # listing.
        assert store.calls == ["stat "]
    finally:
        await ws.close()


class Keys(BaseVFS):
    """A store addressed by path, as Dropbox is: its stat asks by path."""

    name = "keys"

    def __init__(self, files: dict[str, bytes]) -> None:
        super().__init__()
        self.files = files
        self.calls: list[tuple[str, str]] = []

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        self.calls.append(("list", path.vfs_path.strip("/")))
        return [
            FileStat(name=name, type=FileType.FILE, size=len(data))
            for name, data in sorted(self.files.items())
        ]

    async def stat(self, path: PathSpec) -> FileStat:
        key = path.vfs_path.strip("/")
        if not key:
            return FileStat(name="/", type=FileType.DIRECTORY)
        self.calls.append(("stat", key))
        if key not in self.files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=key, type=FileType.FILE, size=len(self.files[key])
        )

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
        entry: FileStat | None = None,
    ) -> bytes:
        if entry is None:
            raise FileNotFoundError(path.virtual)
        key = path.vfs_path.strip("/")
        self.calls.append(("read", key))
        return self.files[key]


@pytest.mark.asyncio
async def test_a_name_an_earlier_listing_leaves_out_is_asked_by_path():
    keys = Keys({"f": b"1\n"})
    ws = Workspace({"/k": keys})
    try:
        await (await ws.shell("ls /k")).stdout_str()
        keys.files["new"] = b"2\n"
        keys.calls.clear()
        r = await ws.shell("cat /k/new")
        out = await r.stdout_str()
    finally:
        await ws.close()
    assert (r.exit_code, out) == (0, "2\n")
    assert ("stat", "new") in keys.calls and ("read", "new") in keys.calls
    assert ("list", "") not in keys.calls


@pytest.mark.asyncio
async def test_a_listing_the_command_fetched_proves_a_name_absent():
    keys = Keys({"f": b"1\n"})
    ws = Workspace({"/k": keys})
    try:
        r = await ws.shell("cat /k/f* /k/missing")
        await r.stderr_str()
    finally:
        await ws.close()
    assert r.exit_code == 1
    assert ("stat", "missing") not in keys.calls


@pytest.mark.asyncio
async def test_a_miss_outside_a_command_asks_by_path():
    keys = Keys({"f": b"1\n"})
    ws = Workspace({"/k": keys})
    try:
        await (await ws.shell("ls /k")).stdout_str()
        keys.files["new"] = b"2\n"
        found = await ws.vfs.stat("/k/new")
    finally:
        await ws.close()
    assert found.name == "new"
