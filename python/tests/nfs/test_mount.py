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
import sys

import pytest

from mirage.nfs.config import NFSConfig
from mirage.nfs.mount import (await_ismount, last_resort_args, mount_args,
                              mount_options, prepare_mountpoint, run_umount,
                              umount_args)


def test_mount_args_darwin_pins_port_and_export():
    argv = mount_args("/tmp/m", 20490, "/docs", platform="darwin")
    assert argv[0] == "mount_nfs"
    joined = " ".join(argv)
    assert "port=20490" in joined and "mountport=20490" in joined
    assert "actimeo=0" in joined
    assert argv[-2] == "127.0.0.1:/docs"
    assert argv[-1] == "/tmp/m"


def test_mount_args_linux_uses_mount_t_nfs():
    argv = mount_args("/tmp/m", 111, "/", platform="linux")
    assert argv[:3] == ["mount", "-t", "nfs"]
    assert "nolock" in " ".join(argv)
    assert argv[-2] == "127.0.0.1:/"


def test_mount_options_darwin_carry_the_whole_escape_hatch():
    opts = mount_options(20490, NFSConfig(), platform="darwin")
    parts = opts.split(",")
    assert "soft" in parts
    assert "intr" in parts
    assert "timeo=50" in parts
    assert "retrans=3" in parts
    assert "deadtimeout=60" in parts


def test_mount_options_linux_omit_intr():
    # Linux has ignored intr since 2.6.25; soft is the whole answer
    # there, and an option the kernel drops is noise in the argv.
    parts = mount_options(20490, NFSConfig(), platform="linux").split(",")
    assert "soft" in parts and "timeo=50" in parts
    assert "intr" not in parts
    assert "deadtimeout=60" not in parts


def test_mount_options_honor_a_hard_mount_choice():
    config = NFSConfig(soft=False, dead_timeout=0, timeo=17, retrans=9)
    parts = mount_options(20490, config, platform="darwin").split(",")
    assert "soft" not in parts
    assert not any(part.startswith("deadtimeout=") for part in parts)
    assert "timeo=17" in parts and "retrans=9" in parts
    # intr survives a hard mount on purpose: it is what makes the
    # blocked I/O killable, which is the only escape a hard mount has.
    assert "intr" in parts


def test_mount_args_carry_the_config_options():
    argv = mount_args("/tmp/m",
                      20490,
                      "/",
                      NFSConfig(timeo=11),
                      platform="darwin")
    assert "timeo=11" in argv[2]


def test_umount_args_per_platform():
    assert umount_args("/tmp/m", platform="linux") == ["umount", "/tmp/m"]
    assert umount_args("/tmp/m", platform="darwin") == ["umount", "/tmp/m"]


def test_umount_args_force_is_the_nfs_escape():
    assert umount_args("/tmp/m", force=True) == ["umount", "-f", "/tmp/m"]


def test_prepare_mountpoint_creates_and_owns_a_temp_dir(tmp_path):
    path, owns = prepare_mountpoint(None)
    assert owns is True
    import os
    assert os.path.isdir(path)
    os.rmdir(path)


def test_prepare_mountpoint_keeps_a_caller_path(tmp_path):
    target = str(tmp_path / "mnt")
    path, owns = prepare_mountpoint(target)
    assert path == target and owns is False
    import os
    assert os.path.isdir(target)


async def _always_false(path: str) -> bool:
    return False


async def _always_true(path: str) -> bool:
    return True


def test_await_ismount_times_out_with_a_clear_error():
    with pytest.raises(TimeoutError) as exc:
        asyncio.run(
            await_ismount("/tmp/never", timeout=0.05, probe=_always_false))
    assert "/tmp/never" in str(exc.value)


def test_await_ismount_returns_when_the_probe_passes():
    asyncio.run(await_ismount("/tmp/now", timeout=1.0, probe=_always_true))


async def _never(path: str) -> bool:
    await asyncio.sleep(3600)
    return True


def test_await_ismount_times_out_when_a_probe_never_answers():
    # The stat of a mount whose server has stopped never returns, so a
    # deadline checked only between probes is a deadline that never
    # fires. This is the regression that hung the battery.
    with pytest.raises(TimeoutError):
        asyncio.run(
            await_ismount("/tmp/wedged",
                          timeout=0.2,
                          probe=_never,
                          probe_timeout=0.05))


def test_last_resort_is_lazy_on_linux_and_diskutil_on_darwin():
    # macOS umount takes only -fv, so a lazy detach is not expressible
    # there; linux has no diskutil.
    assert last_resort_args("/tmp/m",
                            platform="linux") == ["umount", "-l", "/tmp/m"]
    assert last_resort_args("/tmp/m", platform="darwin") == [
        "diskutil", "unmount", "force", "/tmp/m"
    ]


def test_run_umount_walks_every_rung_then_gives_up(monkeypatch):
    calls: list[list[str]] = []

    async def refuse(argv: list[str], timeout: float) -> int | None:
        del timeout
        calls.append(argv)
        return 1

    monkeypatch.setattr(sys, "platform", "darwin")
    asyncio.run(run_umount("/tmp/m", runner=refuse, retry_pause=0))
    assert calls == [
        ["umount", "/tmp/m"],
        ["umount", "/tmp/m"],
        ["umount", "-f", "/tmp/m"],
        ["diskutil", "unmount", "force", "/tmp/m"],
    ]


def test_run_umount_retries_a_busy_target_before_forcing(monkeypatch):
    # EBUSY is usually a child that has not finished exiting, so the
    # same plain unmount answers a moment later.
    calls: list[list[str]] = []
    codes = [1, 0]

    async def busy_then_free(argv: list[str], timeout: float) -> int | None:
        del timeout
        calls.append(argv)
        return codes.pop(0)

    monkeypatch.setattr(sys, "platform", "linux")
    asyncio.run(run_umount("/tmp/m", runner=busy_then_free, retry_pause=0))
    assert calls == [["umount", "/tmp/m"], ["umount", "/tmp/m"]]


def test_run_umount_skips_the_retry_when_the_first_attempt_hung(monkeypatch):
    # A timeout is a wedged mount, not a busy one: repeating the plain
    # unmount would only spend the same wait again.
    calls: list[list[str]] = []

    async def hang_then_refuse(argv: list[str], timeout: float) -> int | None:
        del timeout
        calls.append(argv)
        return None if len(calls) == 1 else 1

    monkeypatch.setattr(sys, "platform", "linux")
    asyncio.run(run_umount("/tmp/m", runner=hang_then_refuse, retry_pause=0))
    assert calls == [
        ["umount", "/tmp/m"],
        ["umount", "-f", "/tmp/m"],
        ["umount", "-l", "/tmp/m"],
    ]


def test_run_umount_stops_at_the_first_success():
    calls: list[list[str]] = []

    async def accept(argv: list[str], timeout: float) -> int | None:
        del timeout
        calls.append(argv)
        return 0

    asyncio.run(run_umount("/tmp/m", runner=accept, retry_pause=0))
    assert calls == [["umount", "/tmp/m"]]


def test_run_umount_warns_when_nothing_clears_the_mount(monkeypatch, caplog):

    async def refuse(argv: list[str], timeout: float) -> int | None:
        del argv, timeout
        return None

    monkeypatch.setattr(sys, "platform", "linux")
    with caplog.at_level("WARNING", logger="mirage.nfs.mount"):
        asyncio.run(run_umount("/tmp/m", runner=refuse, retry_pause=0))
    assert "sudo umount -l /tmp/m" in caplog.text


def test_config_is_reused_for_defaults():
    assert NFSConfig().port == 20490
    assert sys.platform in ("darwin", "linux", "win32")


def test_mount_args_take_the_source_host_from_the_config():
    # The server binds to config.host, so a config naming another
    # loopback alias would otherwise be mounted from an address nothing
    # is listening on.
    argv = mount_args("/tmp/m",
                      20490,
                      "/docs",
                      config=NFSConfig(host="127.0.0.2"),
                      platform="darwin")

    assert "127.0.0.2:/docs" in argv
    assert "127.0.0.1:/docs" not in argv


def test_mount_args_default_to_loopback():
    argv = mount_args("/tmp/m", 20490, "/docs", platform="darwin")

    assert "127.0.0.1:/docs" in argv
