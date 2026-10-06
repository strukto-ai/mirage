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
from mirage.ops.registry import RegisteredOp, op
from mirage.types import PathSpec
from mirage.vfs.ram import RAMVFS


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.strip("/"),
        virtual=virtual,
        directory="/",
        pattern=None,
        resolved=True,
    )


class TestOpDecorator:
    def test_attaches_metadata(self):
        @op("read", vfs="s3")
        async def my_read(config, path):
            return b"data"

        assert hasattr(my_read, "_registered_ops")
        assert len(my_read._registered_ops) == 1
        ro = my_read._registered_ops[0]
        assert isinstance(ro, RegisteredOp)
        assert ro.name == "read"
        assert ro.vfs == "s3"
        assert ro.filetype is None

    def test_write_defaults_false(self):
        @op("read", vfs="s3")
        async def my_read2(config, path):
            return b"data"

        ro = my_read2._registered_ops[0]
        assert ro.write is False

    def test_write_flag_true(self):
        @op("write", vfs="s3", write=True)
        async def my_write(config, path, data):
            pass

        ro = my_write._registered_ops[0]
        assert ro.write is True

    def test_with_filetype(self):
        @op("read", vfs="s3", filetype=".parquet")
        async def read_parquet(config, path):
            return b"parquet data"

        ro = read_parquet._registered_ops[0]
        assert ro.filetype == ".parquet"
        assert ro.vfs == "s3"

    def test_stacks(self):
        @op("read", vfs="s3")
        @op("read", vfs="ram")
        async def read_multi(bind_arg, path):
            return b"data"

        assert len(read_multi._registered_ops) == 2


class TestFiletypeOps:
    @pytest.mark.asyncio
    async def test_default_read_still_works(self):
        vfs = RAMVFS()
        store = vfs._store
        store.dirs.add("/")
        store.files["/test.txt"] = b"hello"
        store.modified["/test.txt"] = "2024-01-01T00:00:00"
        ws = Workspace({"/data/": vfs}, mode=MountMode.READ)
        result = await ws.vfs.read("/data/test.txt")
        assert result == b"hello"
