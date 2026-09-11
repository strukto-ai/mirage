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

from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.provision import Precision, ProvisionResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


@pytest.mark.asyncio
async def test_dry_run_dispatch_with_provision_fn():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/a.txt", b"hello world")

    async def my_cat(store, paths, *texts, **_extra):
        return b"hello world", IOResult()

    async def my_cat_dry_run(store, paths, *texts, **_extra):
        return ProvisionResult(
            command=f"cat {paths[0]}",
            network_read_low=11,
            network_read_high=11,
            read_ops=1,
        )

    rc = RegisteredCommand(
        "cat",
        spec=SPECS["cat"],
        resource="ram",
        filetype=None,
        fn=my_cat,
        provision_fn=my_cat_dry_run,
    )
    ws._registry.mount_for("/tmp/").register(rc)

    result = await ws.execute("cat /tmp/a.txt", provision=True)
    assert isinstance(result, ProvisionResult)
    assert result.network_read_low == 11
    assert result.read_ops == 1


def test_dry_run_dispatch_without_provision_fn():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    asyncio.run(ws.fs.write("/tmp/a.txt", b"hello"))

    async def my_cmd(store, paths, *texts, **_extra):
        return b"ok", IOResult()

    rc = RegisteredCommand(
        "mycmd",
        spec=SPECS["cat"],
        resource="ram",
        filetype=None,
        fn=my_cmd,
    )
    ws._registry.mount_for("/tmp/").register(rc)

    result = _run(ws.execute("mycmd /tmp/a.txt", provision=True))
    assert isinstance(result, ProvisionResult)
    assert result.precision == Precision.UNKNOWN


def test_dry_run_command_not_found():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    result = _run(ws.execute("nonexistent /tmp/a.txt", provision=True))
    assert isinstance(result, ProvisionResult)
    assert result.precision == Precision.UNKNOWN


@pytest.mark.asyncio
async def test_dry_run_filetype_specific():
    ws = Workspace(
        {"/tmp/": RAMResource()},
        mode=MountMode.WRITE,
    )
    await ws.fs.write("/tmp/data.avro", b"avro-bytes")

    async def cat_generic(store, paths, *texts, **_extra):
        return b"generic", IOResult()

    async def cat_generic_dry(store, paths, *texts, **_extra):
        return ProvisionResult(command="cat generic",
                               network_read_low=999,
                               network_read_high=999)

    async def cat_avro(store, paths, *texts, **_extra):
        return b"avro", IOResult()

    async def cat_avro_dry(store, paths, *texts, **_extra):
        return ProvisionResult(command="cat avro",
                               network_read_low=10,
                               network_read_high=10)

    mount = ws._registry.mount_for("/tmp/")
    mount.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=None,
                          fn=cat_generic,
                          provision_fn=cat_generic_dry))
    mount.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".avro",
                          fn=cat_avro,
                          provision_fn=cat_avro_dry))

    result = await ws.execute("cat /tmp/data.avro", provision=True)
    assert result.network_read_low == 10
