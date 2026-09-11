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

import os
import subprocess
import sys
from collections.abc import AsyncIterator

import pytest

from mirage import MountMode, Workspace
from mirage.ops.host_io import host_io, in_host_io, with_host_io
from mirage.resource.ram import RAMResource

from .conftest import run

# The configuration the bypass exists for: the mount prefix IS the disk
# resource's root, so every physical path the backend reaches for is
# spelled exactly like a virtual one. Run in a child process, because a
# regression is an unbounded re-entry that hangs instead of raising.
COLLIDING_ROOT = """
import asyncio
import os
import tempfile
from pathlib import Path

from mirage import MountMode, Workspace
from mirage.resource.disk import DiskResource


async def main():
    root = str(Path(tempfile.mkdtemp()).resolve())
    Path(root, "a.txt").write_text("hello")
    mounts = {root + "/": DiskResource(root=root)}
    with Workspace(mounts, mode=MountMode.WRITE) as ws:
        print("listdir", sorted(os.listdir(root)))
        with open(os.path.join(root, "a.txt")) as f:
            print("read", f.read())
        os.mkdir(os.path.join(root, "sub"))
        print("mkdir", os.path.isdir(os.path.join(root, "sub")))
        result = await ws.execute("cat " + root + "/a.txt")
        print("cat", await result.stdout_str())


asyncio.run(main())
"""


async def chunks(seen: list[bool]) -> AsyncIterator[bytes]:
    """A backend-shaped stream that records the bypass as it yields."""
    for text in (b"a", b"b"):
        seen.append(in_host_io())
        yield text


class TestDepth:

    def test_nothing_is_serving_by_default(self):
        assert in_host_io() is False

    def test_a_scope_holds_the_bypass_and_gives_it_back(self):
        with host_io():
            assert in_host_io() is True
        assert in_host_io() is False

    def test_scopes_nest(self):
        with host_io():
            with host_io():
                assert in_host_io() is True
            # An op whose core function ran another op's is still
            # serving after the inner one returned.
            assert in_host_io() is True
        assert in_host_io() is False

    def test_a_raising_scope_still_gives_it_back(self):
        with pytest.raises(ValueError):
            with host_io():
                raise ValueError("backend failed")
        assert in_host_io() is False


class TestDoors:

    def test_the_patched_doors_answer_nothing_while_a_backend_serves(self):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.mkdir("/mem/dir"))
        run(ws.fs.write("/mem/dir/a.txt", b"a"))
        with ws:
            assert os.listdir("/mem/dir") == ["a.txt"]
            with host_io():
                # The host has no /mem, which is the answer a backend
                # reaching for its own physical path needs.
                assert os.path.exists("/mem/dir/a.txt") is False
                with pytest.raises(FileNotFoundError):
                    os.listdir("/mem/dir")
                with pytest.raises(FileNotFoundError):
                    open("/mem/dir/a.txt")
            assert os.path.exists("/mem/dir/a.txt") is True

    def test_a_disk_root_at_its_own_prefix_does_not_re_enter(self):
        proc = subprocess.run([sys.executable, "-c", COLLIDING_ROOT],
                              capture_output=True,
                              text=True,
                              timeout=90)
        assert proc.returncode == 0, proc.stderr
        assert proc.stdout.splitlines() == [
            "listdir ['a.txt']",
            "read hello",
            "mkdir True",
            "cat hello",
        ]


class TestStreams:

    def test_a_wrapped_stream_serves_each_chunk_inside_the_bypass(self):

        async def drain():
            seen: list[bool] = []
            outside: list[bool] = []
            async for chunk in with_host_io(chunks(seen)):
                assert chunk in (b"a", b"b")
                outside.append(in_host_io())
            return seen, outside

        seen, outside = run(drain())
        # The backend body runs with the bypass up; the consumer between
        # chunks does not, so a stream cannot leave it held.
        assert seen == [True, True]
        assert outside == [False, False]
