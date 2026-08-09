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

from mirage.runtime.python.monty.vfs import MontyVFS
from mirage.runtime.vfs import RuntimeVFS


class CountingCore(RuntimeVFS):
    """Core with a counted dispatch, so a cache hit is observable.

    Args:
        files (dict[str, bytes]): the paths the mount holds.
    """

    def __init__(self, files: dict[str, bytes]) -> None:
        super().__init__(dispatch=None, loop=None, mount_prefixes=lambda: [])
        self.files = files
        self.calls: list[tuple[str, str]] = []

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path))
        if op == "read":
            if path not in self.files:
                raise FileNotFoundError(path)
            return self.files[path]
        if op == "readdir":
            prefix = path.rstrip("/") + "/"
            names = {
                p[len(prefix):].split("/")[0]
                for p in self.files if p.startswith(prefix)
            }
            if not names:
                raise FileNotFoundError(path)
            return sorted(names)
        return None

    def ops(self, name: str) -> list[str]:
        return [p for op, p in self.calls if op == name]


def test_a_miss_is_remembered_so_a_repeated_probe_costs_no_dispatch():
    # Monty asks whether a path exists on nearly every guest
    # expression, so the second miss must not reach the mount.
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/nope.txt") is None
    assert vfs.read("/s3/nope.txt") is None
    assert core.ops("read") == ["/s3/nope.txt"]


def test_a_write_forgets_the_miss_so_the_guest_sees_its_own_file():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/new.txt") is None
    core.files["/s3/new.txt"] = b"fresh"
    vfs.write("/s3/new.txt", b"fresh")
    assert vfs.read("/s3/new.txt") == b"fresh"


def test_an_append_forgets_the_miss_too():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/log.txt") is None
    core.files["/s3/log.txt"] = b"line"
    vfs.append("/s3/log.txt", b"line", b"line")
    assert vfs.read("/s3/log.txt") == b"line"


def test_a_removed_path_is_remembered_without_a_second_dispatch():
    core = CountingCore({"/s3/a.txt": b"1"})
    vfs = MontyVFS(core)
    vfs.unlink("/s3/a.txt")
    assert vfs.read("/s3/a.txt") is None
    assert core.ops("read") == []


def test_a_rename_forgets_the_destination_and_remembers_the_source():
    core = CountingCore({"/s3/a.txt": b"one"})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/b.txt") is None
    core.files["/s3/b.txt"] = core.files.pop("/s3/a.txt")
    vfs.rename("/s3/a.txt", "/s3/b.txt")
    assert vfs.read("/s3/b.txt") == b"one"
    assert vfs.read("/s3/a.txt") is None


def test_an_rmdir_is_remembered_and_a_mkdir_forgets():
    core = CountingCore({})
    vfs = MontyVFS(core)
    vfs.rmdir("/s3/gone")
    assert vfs.read("/s3/gone") is None
    assert core.ops("read") == []
    vfs.mkdir("/s3/gone", parents=False)
    assert vfs.read("/s3/gone") is None
    assert core.ops("read") == ["/s3/gone"]


def test_a_listing_miss_is_not_cached_because_a_directory_may_gain_entries():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.readdir("/s3/d") is None
    core.files["/s3/d/a.txt"] = b"1"
    assert vfs.readdir("/s3/d") == ["a.txt"]


def test_an_unwired_view_answers_none_and_swallows_no_mutation():
    # The runtime is built without a workspace: every question answers
    # "not here" and every mutation is a no-op rather than a crash.
    vfs = MontyVFS(None)
    assert vfs.wired is False
    assert vfs.read("/s3/a.txt") is None
    assert vfs.readdir("/s3") is None
    vfs.write("/s3/a.txt", b"x")
    vfs.unlink("/s3/a.txt")
