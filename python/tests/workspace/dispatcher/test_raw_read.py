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

import pytest

from mirage import MountMode, Workspace
from mirage.core.ram.stat import stat as ram_stat
from mirage.io import IOResult
from mirage.types import FileStat, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from tests.fixtures.vfs_io import override, render

# A raw read is what read-modify-write needs: FUSE hands the merged
# buffer straight back to ``write``, which always stores, so a read that
# rendered would store the rendering over the file. Two things can serve
# a rendering, and ``raw`` has to defeat both: the renderer the VFS names
# for the extension, and the file cache a command's rendered read already
# filled under the same path.


async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED"


class _CachingRAM(RAMVFS):
    caches_reads = True


def _workspace(vfs: RAMVFS) -> Workspace:
    render(vfs, ".tally", _read_tally)
    return Workspace({"/data/": vfs}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_read_resolves_the_renderer():
    ws = _workspace(RAMVFS())
    await ws.vfs.write("/data/books.tally", b"STORED")
    assert await ws.vfs.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
async def test_raw_read_skips_the_renderer():
    ws = _workspace(RAMVFS())
    await ws.vfs.write("/data/books.tally", b"STORED")
    assert await ws.vfs.read("/data/books.tally", raw=True) == b"STORED"


@pytest.mark.asyncio
async def test_raw_read_leaves_an_unregistered_extension_alone():
    ws = _workspace(RAMVFS())
    await ws.vfs.write("/data/notes.txt", b"plain")
    assert await ws.vfs.read("/data/notes.txt", raw=True) == b"plain"


@pytest.mark.asyncio
async def test_raw_read_is_served_from_the_file_cache():
    # The file cache holds the stored bytes commands read, never a
    # rendering, which is what a raw read asks for.
    ws = _workspace(_CachingRAM())
    await ws.vfs.write("/data/books.tally", b"STORED")
    # Distinct from both the stored and the rendered bytes, so a warm hit
    # is distinguishable from either op running.
    await ws.apply_io(
        IOResult(
            reads={"/data/books.tally": b"CACHED"}, cache=["/data/books.tally"]
        )
    )
    assert await ws.vfs.read("/data/books.tally", raw=True) == b"CACHED"


@pytest.mark.asyncio
async def test_an_in_place_edit_rewrites_the_stored_bytes():
    # A command reads the stored bytes, so sed -i writes back an edit of
    # them, never the rendering, and cat agrees with it.
    ws = Workspace(
        {"/data/": _RenderingRAM()},
        mode=MountMode.WRITE,
    )
    await ws.vfs.write("/data/books.tally", b"STORED\n")
    edited = await ws.shell("sed -i 's/STORED/changed/' /data/books.tally")
    assert edited.exit_code == 0
    assert await ws.vfs.read("/data/books.tally", raw=True) == b"changed\n"
    shown = await ws.shell("cat /data/books.tally")
    assert await shown.stdout_str() == "changed\n"


class _RenderingRAM(_CachingRAM):
    """Stands in for a VFS that names its renderer in its class, as gdocs
    does."""

    renderers = {".tally": "read_tally"}

    async def read_tally(self, path: PathSpec, *args, **kwargs) -> bytes:
        return b"RENDERED"


async def _seed(ws: Workspace, path: str) -> None:
    await ws.vfs.write(path, b"STORED")
    await ws.apply_io(IOResult(reads={path: b"CACHED"}, cache=[path]))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /data/books.tally",
        "echo T | tee /data/books.tally",
    ],
    ids=["cat", "tee"],
)
async def test_a_user_renderer_renders_after_a_shell_command(line):
    ws = _workspace(_CachingRAM())
    await ws.vfs.write("/data/books.tally", b"STORED\n")
    result = await ws.shell(line)
    await result.materialize_stdout()
    assert result.exit_code == 0
    assert await ws.cache.exists("/data/books.tally")
    assert await ws.vfs.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cp /data/books.tally /other/copy && cat /other/copy",
        "sed -n p /data/books.tally /other/notes",
        "diff /data/books.tally /other/notes",
    ],
    ids=["cp", "sed", "diff"],
)
async def test_a_cross_mount_relay_never_keeps_a_render(line):
    # A relay reads through the dispatcher, so it reads the rendering; kept
    # under the path, it is what cat would print.
    ws = Workspace(
        {
            "/data/": render(_CachingRAM(), ".tally", _read_tally),
            "/other/": RAMVFS(),
        },
        mode=MountMode.WRITE,
    )
    await ws.vfs.write("/data/books.tally", b"STORED\n")
    await ws.vfs.write("/other/notes", b"N\n")
    result = await ws.shell(line)
    assert "RENDERED" in await result.stdout_str()
    assert not await ws.cache.exists("/data/books.tally")
    out = await ws.shell("cat /data/books.tally")
    assert await out.stdout_str() == "STORED\n"


@pytest.mark.asyncio
async def test_a_renderer_named_by_filetype_is_never_served_warm():
    ws = _workspace(_CachingRAM())
    await _seed(ws, "/data/notes.txt")
    data, _ = await ws.dispatch(
        "read", PathSpec.from_str_path("/data/notes.txt"), filetype=".tally"
    )
    assert data == b"RENDERED"


@pytest.mark.asyncio
async def test_a_warm_cache_still_answers_a_ranged_read_with_the_window():
    # The cache holds the whole object; a ranged read asked for a
    # window instead of the file, so serving the file back is wrong.
    # git reads pack indexes this way (4 bytes at a known offset), and
    # the dispatcher is the door it reaches too.
    ws = _workspace(_CachingRAM())
    await ws.vfs.write("/data/f.bin", b"0123456789")
    await ws.apply_io(
        IOResult(reads={"/data/f.bin": b"0123456789"}, cache=["/data/f.bin"])
    )
    assert await ws.vfs.read("/data/f.bin", 2, 3) == b"234"
    assert await ws.vfs.read("/data/f.bin") == b"0123456789"
    assert await ws.vfs.read("/data/f.bin", 7) == b"789"
    assert await ws.vfs.read("/data/f.bin", 2, 0) == b""
    assert await ws.vfs.read("/data/f.bin", 99, 3) == b""


@pytest.mark.asyncio
async def test_a_cold_and_a_warm_ranged_read_agree():
    ws = _workspace(_CachingRAM())
    await ws.vfs.write("/data/f.bin", b"0123456789")
    cold = await ws.vfs.read("/data/f.bin", 2, 3)
    await ws.apply_io(
        IOResult(reads={"/data/f.bin": b"0123456789"}, cache=["/data/f.bin"])
    )
    assert await ws.vfs.read("/data/f.bin", 2, 3) == cold


def _fresh_rendering_workspace(vfs: RAMVFS) -> Workspace:
    vfs.read_revalidatable = True
    return Workspace(
        {"/data/": render(vfs, ".tally", _read_tally)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )


@pytest.mark.asyncio
async def test_a_user_renderer_read_of_a_remotely_deleted_path_fails_under_fresh():
    # The cached entry is never served to a user renderer, but its freshness
    # check still runs: a path the backend reports gone fails, as it does
    # for every other warm read, instead of reaching a renderer that may not
    # look at the backend at all.
    vfs = _CachingRAM()
    ws = _fresh_rendering_workspace(vfs)
    await _seed(ws, "/data/books.tally")
    other = Workspace({"/data/": vfs}, mode=MountMode.WRITE)
    await other.vfs.unlink("/data/books.tally")
    with pytest.raises(FileNotFoundError):
        await ws.vfs.read("/data/books.tally")


async def _stat_with_version(accessor, path: PathSpec, **kwargs) -> FileStat:
    stat = await ram_stat(accessor, path)
    return stat.model_copy(update={"fingerprint": "v1"})


@pytest.mark.asyncio
async def test_a_user_renderer_still_renders_under_fresh():
    # The entry carries the version the backend answers, so the freshness
    # check would serve it: only the renderer rule keeps the bytes out.
    ws = _fresh_rendering_workspace(_CachingRAM())
    await ws.vfs.write("/data/books.tally", b"STORED")
    override(ws.mount("/data/").vfs, "stat", _stat_with_version)
    await ws.cache.set("/data/books.tally", b"CACHED", fingerprint="v1")
    assert await ws.vfs.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
async def test_a_renderer_registered_mid_read_is_never_served_warm():
    # The renderer lands while the read waits on the cache; the entry it
    # finds is still the command's raw bytes, not this rendering.
    ws = Workspace({"/data/": _CachingRAM()}, mode=MountMode.WRITE)
    await _seed(ws, "/data/books.tally")
    original = ws.cache.get

    async def get_then_register(path, *args, **kwargs):
        data = await original(path, *args, **kwargs)
        render(ws.mount("/data/").vfs, ".tally", _read_tally)
        return data

    ws.cache.get = get_then_register
    assert await ws.vfs.read("/data/books.tally") == b"RENDERED"


def _renderer_on_mount() -> Workspace:
    return _workspace(_CachingRAM())


def _renderer_in_vfs() -> Workspace:
    return Workspace({"/data/": _RenderingRAM()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "build",
    [_renderer_on_mount, _renderer_in_vfs],
    ids=["added-on-the-mount", "shipped-by-the-vfs"],
)
async def test_a_filetype_renderer_is_never_served_from_the_file_cache(build):
    # Commands fill the cache with what their own reads return. A
    # renderer, whoever named it, renders on every read instead.
    ws = build()
    await _seed(ws, "/data/books.tally")
    assert await ws.vfs.read("/data/books.tally") == b"RENDERED"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("build", "path"),
    [
        (_renderer_on_mount, "/data/notes.txt"),
        (_renderer_on_mount, "/data/README"),
    ],
    ids=["plain-path", "extensionless-path"],
)
async def test_a_read_no_filetype_renderer_resolves_is_still_served_warm(
    build, path
):
    # Only a renderer for the path's filetype renders: another path or no
    # extension leaves the cache in charge.
    ws = build()
    await _seed(ws, path)
    assert await ws.vfs.read(path) == b"CACHED"
