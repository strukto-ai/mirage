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
from mirage.commands.config import command
from mirage.commands.registry import RegisteredCommand
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.ops.registry import op
from mirage.resource.ram import RAMResource


@pytest.fixture
def ws():
    return Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)


@pytest.fixture
def ws_two_mounts():
    return Workspace({
        "/a": RAMResource(),
        "/b": RAMResource(),
    },
                     mode=MountMode.WRITE)


def test_ws_mounts_returns_all(ws):
    mounts = ws.mounts()
    prefixes = [m.prefix for m in mounts]
    assert "/data/" in prefixes


def test_ws_mount_by_prefix(ws):
    m = ws.mount("/data/")
    assert m.prefix == "/data/"


def test_commands_introspection(ws):
    m = ws.mount("/data/")
    cmds = m.commands()
    assert isinstance(cmds, dict)
    assert "cat" in cmds
    assert None in cmds["cat"]


def test_registered_ops_introspection(ws):
    m = ws.mount("/data/")
    ops = m.registered_ops()
    assert isinstance(ops, dict)
    assert "read" in ops
    assert "stat" in ops


def test_register_fns_adds_command(ws):

    @command("test_custom", resource="ram", spec=SPECS["cat"])
    async def custom(accessor, paths, *texts, **kw):
        return b"custom", IOResult()

    m = ws.mount("/data/")
    assert "test_custom" not in m.commands()
    m.register_fns([custom])
    assert "test_custom" in m.commands()


def test_register_fns_adds_op(ws):

    @op("test_custom_op", resource="ram")
    async def custom_op(accessor, scope, **kwargs):
        return b"hello"

    m = ws.mount("/data/")
    assert "test_custom_op" not in m.registered_ops()
    m.register_fns([custom_op])
    assert "test_custom_op" in m.registered_ops()


def test_unregister_removes_command(ws):
    m = ws.mount("/data/")
    assert "rm" in m.commands()
    m.unregister(["rm"])
    assert "rm" not in m.commands()


def test_unregister_removes_all_filetypes(ws):
    # mirage ships no filetype renderers, so register one to prove the
    # extension point still works and that unregister clears every variant.
    m = ws.mount("/data/")

    async def demo_cat(store, paths, *texts, **kwargs):
        return b"demo", IOResult()

    m.register(
        RegisteredCommand("cat",
                          spec=SPECS["cat"],
                          resource="ram",
                          filetype=".demo",
                          fn=demo_cat))
    assert len(m.commands().get("cat", [])) > 1
    m.unregister(["cat"])
    assert "cat" not in m.commands()


@pytest.mark.asyncio
async def test_unregister_then_register_works(ws):
    m = ws.mount("/data/")
    m.unregister(["cat"])
    assert "cat" not in m.commands()

    @command("cat", resource="ram", spec=SPECS["cat"])
    async def custom_cat(accessor, paths, *texts, **kw):
        return b"custom cat output", IOResult()

    m.register_fns([custom_cat])
    assert "cat" in m.commands()
    await ws.execute('echo hello | tee /data/hello.txt')
    result = await ws.execute("cat /data/hello.txt")
    assert result.exit_code == 0
    assert b"custom cat output" in result.stdout


def test_register_isolated_per_mount(ws_two_mounts):
    ma = ws_two_mounts.mount("/a/")
    mb = ws_two_mounts.mount("/b/")
    ma.unregister(["rm"])
    assert "rm" not in ma.commands()
    assert "rm" in mb.commands()


def test_register_fns_isolated_per_mount(ws_two_mounts):

    @command("only_on_a", resource="ram", spec=SPECS["cat"])
    async def only_a(accessor, paths, *texts, **kw):
        return b"a", IOResult()

    ws_two_mounts.mount("/a/").register_fns([only_a])
    assert "only_on_a" in ws_two_mounts.mount("/a/").commands()
    assert "only_on_a" not in ws_two_mounts.mount("/b/").commands()


def test_register_fns_wrong_resource_raises(ws):

    @command("s3_only", resource="s3", spec=SPECS["cat"])
    async def s3_cmd(accessor, paths, *texts, **kw):
        return b"s3", IOResult()

    m = ws.mount("/data/")
    with pytest.raises(ValueError, match=r"'s3'"):
        m.register_fns([s3_cmd])


def test_register_fns_wrong_resource_op_raises(ws):

    @op("s3_read", resource="s3")
    async def s3_op(accessor, scope, **kwargs):
        return b"s3"

    m = ws.mount("/data/")
    with pytest.raises(ValueError, match=r"'s3'"):
        m.register_fns([s3_op])


def test_register_fns_multi_resource_filters_to_matching(ws):

    @command("multi", resource=["ram", "s3"], spec=SPECS["cat"])
    async def multi(accessor, paths, *texts, **kw):
        return b"multi", IOResult()

    m = ws.mount("/data/")
    m.register_fns([multi])
    assert "multi" in m.commands()
