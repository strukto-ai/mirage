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

from mirage.accessor.base import NOOPAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.ops import Ops
from mirage.ops.config import OpsMount
from mirage.ops.registry import OpsRegistry, RegisteredOp, op
from mirage.ops.s3 import OPS as S3_VFS_OPS
from mirage.resource.ram import RAMResource
from mirage.types import MountMode


class TestOpDecorator:

    def test_attaches_metadata(self):

        @op("read", resource="s3")
        async def my_read(config, path):
            return b"data"

        assert hasattr(my_read, "_registered_ops")
        assert len(my_read._registered_ops) == 1
        ro = my_read._registered_ops[0]
        assert isinstance(ro, RegisteredOp)
        assert ro.name == "read"
        assert ro.resource == "s3"
        assert ro.filetype is None

    def test_write_defaults_false(self):

        @op("read", resource="s3")
        async def my_read2(config, path):
            return b"data"

        ro = my_read2._registered_ops[0]
        assert ro.write is False

    def test_write_flag_true(self):

        @op("write", resource="s3", write=True)
        async def my_write(config, path, data):
            pass

        ro = my_write._registered_ops[0]
        assert ro.write is True

    def test_with_filetype(self):

        @op("read", resource="s3", filetype=".parquet")
        async def read_parquet(config, path):
            return b"parquet data"

        ro = read_parquet._registered_ops[0]
        assert ro.filetype == ".parquet"
        assert ro.resource == "s3"

    def test_stacks(self):

        @op("read", resource="s3")
        @op("read", resource="ram")
        async def read_multi(bind_arg, path):
            return b"data"

        assert len(read_multi._registered_ops) == 2


class TestOpsRegistry:

    @pytest.mark.asyncio
    async def test_resource_lookup(self):
        registry = OpsRegistry()

        @op("read", resource="ram")
        async def mem_read(store, path):
            return b"memory data"

        registry.register(mem_read)
        fn = registry.resolve("read", "ram")
        assert fn is not None
        result = await fn(None, "/test")
        assert result == b"memory data"

    @pytest.mark.asyncio
    async def test_filetype_priority(self):
        registry = OpsRegistry()

        @op("read", resource="s3", filetype=".parquet")
        async def read_parquet(config, path):
            return b"parquet"

        @op("read", resource="s3")
        async def read_default(config, path):
            return b"default"

        registry.register(read_parquet)
        registry.register(read_default)

        fn = registry.resolve("read", "s3", filetype=".parquet")
        result = await fn(None, "/test.parquet")
        assert result == b"parquet"

        fn = registry.resolve("read", "s3", filetype=".txt")
        result = await fn(None, "/test.txt")
        assert result == b"default"

    @pytest.mark.asyncio
    async def test_none_fallthrough(self):
        registry = OpsRegistry()

        @op("read", resource="s3", filetype=".custom")
        async def read_custom(config, path):
            return None

        @op("read", resource="s3")
        async def read_default(config, path):
            return b"fallback"

        registry.register(read_custom)
        registry.register(read_default)

        result = await registry.call("read",
                                     "s3", (None, ),
                                     "/test.custom",
                                     filetype=".custom")
        assert result == b"fallback"

    @pytest.mark.asyncio
    async def test_not_found(self):
        registry = OpsRegistry()
        with pytest.raises(KeyError):
            registry.resolve("read", "redis")

    def test_register_registered_op(self):
        registry = OpsRegistry()

        async def my_fn(store, path):
            return b"data"

        ro = RegisteredOp(name="read", resource="ram", filetype=None, fn=my_fn)
        registry.register(ro)
        assert registry.resolve("read", "ram") is my_fn

    def test_register_type_error(self):
        registry = OpsRegistry()
        with pytest.raises(TypeError):
            registry.register("not a function")


class TestUserOpOverride:

    @pytest.mark.asyncio
    async def test_user_op_overrides_builtin(self):
        registry = OpsRegistry()
        builtin = RegisteredOp(name="read",
                               resource="disk",
                               filetype=None,
                               fn=lambda acc, p, **kw: b"builtin")
        registry.register(builtin)

        @op("read", resource="disk")
        async def custom_read(accessor, path, **kwargs):
            return b"custom"

        registry.register(custom_read)
        fn = registry.resolve("read", "disk")
        result = await fn(None, "/test")
        assert result == b"custom"

    @pytest.mark.asyncio
    async def test_user_filetype_op_overrides_builtin(self):
        registry = OpsRegistry()
        builtin = RegisteredOp(name="read",
                               resource="s3",
                               filetype=".parquet",
                               fn=lambda acc, p, **kw: b"builtin-parquet")
        registry.register(builtin)

        @op("read", resource="s3", filetype=".parquet")
        async def my_parquet(accessor, path, **kwargs):
            return b"my-parquet"

        registry.register(my_parquet)
        fn = registry.resolve("read", "s3", filetype=".parquet")
        result = await fn(None, "/data.parquet")
        assert result == b"my-parquet"


class TestFiletypeOps:

    @pytest.mark.asyncio
    async def test_registered_for_s3(self):
        s3_ops = list(S3_VFS_OPS)
        mount = OpsMount(
            prefix="/s3/",
            resource_type="s3",
            accessor=NOOPAccessor(),
            index=RAMIndexCacheStore(),
            mode=MountMode.READ,
            ops=s3_ops,
        )
        ops = Ops([mount])
        fn = ops._registry.resolve("read", "s3", filetype=".parquet")
        assert fn is not None

    @pytest.mark.asyncio
    async def test_default_read_still_works(self):
        resource = RAMResource()
        store = resource._store
        store.dirs.add("/")
        store.files["/test.txt"] = b"hello"
        store.modified["/test.txt"] = "2024-01-01T00:00:00"
        mount = OpsMount(
            prefix="/data/",
            resource_type="ram",
            accessor=resource.accessor,
            index=RAMIndexCacheStore(),
            mode=MountMode.READ,
            ops=resource.ops_list(),
        )
        ops = Ops([mount])
        result = await ops.read("/data/test.txt")
        assert result == b"hello"
