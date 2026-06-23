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

from mirage.commands.registry import command
from mirage.commands.spec import SPECS, CommandSpec, Operand, OperandKind
from mirage.core.disk.glob import resolve_glob
from mirage.core.disk.read import read_bytes
from mirage.io.types import IOResult
from mirage.ops.registry import op
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.mount import MountEntry

ECHO_SPEC = CommandSpec(positional=(Operand(kind=OperandKind.PATH), ))


@command("stat", resource="disk", spec=SPECS["stat"], filetype=".zzz")
async def stat_zzz_disk(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin=None,
    index=None,
    **_extra: object,
) -> tuple[bytes | None, IOResult]:
    paths = await resolve_glob(accessor, paths, index)
    raw = await read_bytes(accessor, paths[0])
    return b"CUSTOM DISK STAT %d\n" % len(raw), IOResult(
        reads={paths[0].strip_prefix: raw}, cache=[paths[0].strip_prefix])


@command("stat", resource="ram", spec=SPECS["stat"], filetype=".zzz")
async def stat_zzz_ram(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin=None,
    **_extra: object,
) -> tuple[bytes | None, IOResult]:
    return b"CUSTOM RAM STAT\n", IOResult()


@command("echopath", resource="ram", spec=ECHO_SPEC)
async def echopath(
    accessor,
    paths: list[PathSpec],
    *texts: str,
    stdin=None,
    **_extra: object,
) -> tuple[bytes | None, IOResult]:
    if not paths:
        return None, IOResult(exit_code=1,
                              stderr=b"echopath: missing operand\n")
    return f"echopath:{paths[0].original}".encode(), IOResult()


@op("hello_op", resource="ram")
async def hello_op(accessor, path, *args, **kwargs) -> str:
    return f"hello:{path}"


def test_cache_mount_is_default_mount():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    assert isinstance(ws.cache_mount, MountEntry)
    assert ws.cache_mount is ws._registry.default_mount
    assert ws.cache_mount.prefix == "/_default/"


def test_cache_mount_resource_is_cache():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    assert ws.cache_mount.resource is ws.cache


def test_cache_mount_register_command():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    ws.cache_mount.register_fns([echopath])
    cmd = ws.cache_mount.resolve_command("echopath")
    assert cmd is not None
    assert cmd.fn is echopath


def test_cache_mount_register_op():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)
    ws.cache_mount.register_fns([hello_op])
    assert ("hello_op", None) in ws.cache_mount._ops


def test_cache_mount_rejects_wrong_resource_kind():
    ws = Workspace({"/data/": RAMResource()}, mode=MountMode.WRITE)

    @command("disk_only", resource="disk", spec=ECHO_SPEC)
    async def disk_only(accessor, paths, *texts, stdin=None, **_extra):
        return None, IOResult()

    with pytest.raises(ValueError, match="ram"):
        ws.cache_mount.register_fns([disk_only])


@pytest.mark.asyncio
async def test_custom_stat_after_cache_promotion(tmp_path):
    """After the first stat caches the bytes, the dispatcher reroutes the
    second stat to cache_mount. Without the ram variant registered there,
    the second stat would fall through to built-in stat and lose the custom
    output."""
    (tmp_path / "example.zzz").write_bytes(b"payload")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/": disk}, mode=MountMode.READ)
    ws.mount("/").register_fns([stat_zzz_disk])
    ws.cache_mount.register_fns([stat_zzz_ram])

    first = await ws.execute("stat /example.zzz")
    second = await ws.execute("stat /example.zzz")
    first_text = (await first.stdout_str())
    second_text = (await second.stdout_str())
    assert "CUSTOM DISK STAT" in first_text
    assert "CUSTOM" in second_text, (
        "second stat after cache promotion lost custom handler "
        "(cache_mount missing the ram variant?)")


@pytest.mark.asyncio
async def test_warm_read_stays_on_real_mount(tmp_path):
    """Read-through: the second (cached) read must still run the REAL
    mount's command, not reroute to cache_mount. Today the dispatcher
    redirects warm reads to cache_mount, so the custom disk handler is
    lost and built-in RAM stat answers instead. With read-through the
    cached bytes are served while the command stays on the real mount,
    so no double-registration on cache_mount is needed."""
    (tmp_path / "example.zzz").write_bytes(b"payload")
    disk = DiskResource(root=str(tmp_path))
    disk.caches_reads = True
    ws = Workspace({"/": disk}, mode=MountMode.READ)
    ws.mount("/").register_fns([stat_zzz_disk])
    # Intentionally NOT registering stat_zzz_ram on cache_mount.

    first = await ws.execute("stat /example.zzz")
    second = await ws.execute("stat /example.zzz")
    assert "CUSTOM DISK STAT" in (await first.stdout_str())
    assert "CUSTOM DISK STAT" in (await second.stdout_str()), (
        "warm read rerouted to cache_mount and lost the real mount's "
        "custom handler; read-through should keep it on the real mount")


def test_set_default_mount_auto_registers_resource_ops():
    """Symmetry fix: set_default_mount() now mirrors mount() and pulls in
    resource.ops_list() the same way."""
    res = RAMResource()
    ws = Workspace({"/data/": res}, mode=MountMode.WRITE)
    user_op_keys = set(ws.mount("/data/")._ops.keys())
    cache_op_keys = set(ws.cache_mount._ops.keys())
    cache_resource_op_names = {
        ro.name
        for ro in ws.cache_mount.resource.ops_list()
    }
    for name in cache_resource_op_names:
        assert (name,
                None) in cache_op_keys, f"{name!r} missing on cache mount"
    assert user_op_keys.issubset(cache_op_keys) or len(user_op_keys) == 0
