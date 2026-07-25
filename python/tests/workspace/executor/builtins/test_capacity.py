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
"""df coverage: honest per-mount capacity.

A backend reports real numbers only when it can (disk statvfs, or a
provider quota); everything else renders ``-`` rather than a fabricated
total. Numbers here come from a fixed-quota stub so the output is
deterministic (real disk free space is machine-specific).
"""
import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import CapacityResult, CapacityState, MountMode
from mirage.workspace import Workspace


class _QuotaResource(RAMResource):
    """RAM backend that reports a fixed quota, standing in for a real
    filesystem / a provider that exposes storage numbers."""

    name = "quota"

    async def statfs(self) -> CapacityResult:
        return CapacityResult(
            state=CapacityState.QUOTA,
            total=1024000,
            used=409600,
            available=614400,
            inodes=1000,
            inodes_used=100,
            inodes_free=900,
        )


def _ws() -> Workspace:
    return Workspace(
        {
            "/mem": (RAMResource(), MountMode.WRITE),
            "/q": (_QuotaResource(), MountMode.WRITE),
        },
        mode=MountMode.WRITE,
    )


async def _run(ws: Workspace, cmd: str) -> tuple[int, str]:
    r = await ws.execute(cmd)
    return r.exit_code, await r.stdout_str()


def test_capacity_default_state_is_unknown():
    import asyncio
    cap = asyncio.run(RAMResource().statfs())
    assert cap.state == CapacityState.UNKNOWN
    assert cap.total is None


@pytest.mark.asyncio
async def test_df_unknown_backend_renders_dashes():
    ws = _ws()
    code, out = await _run(ws, "df /mem")
    assert code == 0
    assert out == ("Filesystem     1K-blocks Used Available Use% Mounted on\n"
                   "ram                    -    -         -    - /mem\n")


@pytest.mark.asyncio
async def test_df_quota_backend_reports_real_numbers():
    ws = _ws()
    code, out = await _run(ws, "df /q")
    assert code == 0
    lines = out.splitlines()
    assert lines[0].split() == [
        "Filesystem", "1K-blocks", "Used", "Available", "Use%", "Mounted", "on"
    ]
    assert lines[1].split() == ["quota", "1000", "400", "600", "40%", "/q"]


@pytest.mark.asyncio
async def test_df_type_column():
    ws = _ws()
    code, out = await _run(ws, "df -T /q")
    assert code == 0
    assert out.splitlines()[0].split()[:2] == ["Filesystem", "Type"]
    assert out.splitlines()[1].split()[:2] == ["quota", "quota"]


@pytest.mark.asyncio
async def test_df_inodes():
    ws = _ws()
    code, out = await _run(ws, "df -i /q")
    assert code == 0
    assert out.splitlines()[0].split() == [
        "Filesystem", "Inodes", "IUsed", "IFree", "IUse%", "Mounted", "on"
    ]
    assert out.splitlines()[1].split() == [
        "quota", "1000", "100", "900", "10%", "/q"
    ]
    # unknown backend: inode columns are dashes too
    _, out2 = await _run(ws, "df -i /mem")
    assert out2.splitlines()[1].split() == ["ram", "-", "-", "-", "-", "/mem"]


@pytest.mark.asyncio
async def test_df_posix_and_block_size_headers():
    ws = _ws()
    _, posix = await _run(ws, "df -P /q")
    assert posix.splitlines()[0].split()[1:] == [
        "1024-blocks", "Used", "Available", "Capacity", "Mounted", "on"
    ]
    _, block = await _run(ws, "df -B 1M /q")
    assert block.splitlines()[0].split()[1] == "1M-blocks"
    # 1024000 bytes -> ceil to 1 MiB block
    assert block.splitlines()[1].split()[1] == "1"


@pytest.mark.asyncio
async def test_df_human_readable():
    ws = _ws()
    _, out = await _run(ws, "df -h /q")
    assert out.splitlines()[0].split()[1:4] == ["Size", "Used", "Avail"]
    # 1024000 bytes -> 1000.0K
    assert out.splitlines()[1].split()[1].endswith("K")


@pytest.mark.asyncio
async def test_df_no_args_lists_all_mounts():
    ws = _ws()
    code, out = await _run(ws, "df")
    assert code == 0
    mounted_on = [ln.split()[-1] for ln in out.splitlines()[1:]]
    assert "/mem" in mounted_on
    assert "/q" in mounted_on


@pytest.mark.asyncio
async def test_df_invalid_option():
    ws = _ws()
    code, _ = await _run(ws, "df -z /mem")
    assert code == 2


@pytest.mark.asyncio
async def test_disk_statfs_real_quota(tmp_path):
    # The real disk backend reports real numbers (QUOTA), not fabricated.
    cap = await DiskResource(root=str(tmp_path)).statfs()
    assert cap.state == CapacityState.QUOTA
    assert cap.total and cap.total > 0
    assert cap.available is not None and cap.available >= 0
    assert cap.inodes and cap.inodes > 0


@pytest.mark.asyncio
async def test_df_rejects_zero_block_size():
    # GNU df rejects -B0 with a CLI error rather than dividing by zero.
    ws = _ws()
    code, out = await _run(ws, "df -B0 /q")
    assert code == 1
    assert out == ""
    err = await (await ws.execute("df -B0 /q")).stderr_str()
    assert err == "df: invalid -B argument '0'\n"


@pytest.mark.asyncio
async def test_df_last_size_format_wins():
    # -h/-H/-k/-B are mutually overriding; GNU lets the last one win.
    ws = _ws()
    _, hb = await _run(ws, "df -h -B1M /q")
    assert hb.splitlines()[0].split()[1] == "1M-blocks"
    _, bh = await _run(ws, "df -B1M -h /q")
    assert bh.splitlines()[0].split()[1] == "Size"
    _, hk = await _run(ws, "df -h -k /q")
    assert hk.splitlines()[0].split()[1] == "1K-blocks"
    _, kh = await _run(ws, "df -k -h /q")
    assert kh.splitlines()[0].split()[1] == "Size"


@pytest.mark.asyncio
async def test_df_missing_file_operand_errors():
    # GNU df errors on a missing FILE; an existing path (and the mount root)
    # report normally.
    ws = _ws()
    await ws.execute("mkdir -p /mem/sub")
    await ws.execute("sh -c 'echo hi > /mem/sub/f.txt'")
    assert (await _run(ws, "df /mem/sub/f.txt"))[0] == 0
    assert (await _run(ws, "df /mem"))[0] == 0
    code, out = await _run(ws, "df /mem/missing")
    assert code == 1
    assert out == ""
    err = await (await ws.execute("df /mem/missing")).stderr_str()
    assert err == "df: /mem/missing: No such file or directory\n"


@pytest.mark.asyncio
async def test_df_follows_symlink_to_target_mount():
    # GNU df follows a FILE operand, so a symlink reports the mount of its
    # target, not the mount holding the link.
    ws = _ws()
    await ws.execute("ln -s /q /mem/link")
    code, out = await _run(ws, "df /mem/link")
    assert code == 0
    assert out.splitlines()[-1].split()[-1] == "/q"
