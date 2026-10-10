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
import inspect
import stat

import asyncssh
import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.server.ssh.constants import LISTING_CONCURRENCY
from mirage.server.ssh.sftp import (
    MirageSFTPServer,
    filetype,
    listing,
    to_attrs,
)
from tests.server.ssh.conftest import (
    bind_key,
    start_harness,
    stop_harness,
    vault_workspace,
)

# The base-class members that never touch the host filesystem: accessors
# and formatting helpers. Every other method of asyncssh.SFTPServer serves
# the local disk unless overridden, so the guard below must see each one
# redefined on MirageSFTPServer.
HOST_SAFE = {
    "__init__",
    "channel",
    "connection",
    "env",
    "logger",
    "convert_attrs",
    "format_user",
    "format_group",
    "format_longname",
}

PAYLOAD = bytes(range(256)) * 300

# SSH_FXP_INIT asking for version 3: length 5, type 1, version 3.
FXP_INIT_V3 = b"\x00\x00\x00\x05\x01\x00\x00\x00\x03"
FXP_VERSION = 2


def test_every_host_reaching_method_is_overridden():
    base = {
        name
        for name, member in vars(asyncssh.SFTPServer).items()
        if inspect.isfunction(member) and not name.startswith("_")
    }
    exposed = sorted(base - HOST_SAFE - set(vars(MirageSFTPServer)))
    assert not exposed, (
        "asyncssh.SFTPServer serves the host filesystem from these; "
        f"override them on MirageSFTPServer: {exposed}"
    )


def test_attrs_carry_type_mode_size_and_split_times():
    st = {
        "st_mode": stat.S_IFREG | 0o640,
        "st_size": 12,
        "st_uid": 501,
        "st_gid": 20,
        "st_nlink": 1,
        "st_atime": 1_700_000_000_123_456_789,
        "st_mtime": 1_700_000_001_000_000_005,
    }
    attrs = to_attrs(st)
    assert attrs.type == filetype(stat.S_IFREG)
    assert (attrs.size, attrs.permissions) == (12, stat.S_IFREG | 0o640)
    assert (attrs.atime, attrs.atime_ns) == (1_700_000_000, 123_456_789)
    assert (attrs.mtime, attrs.mtime_ns) == (1_700_000_001, 5)


@pytest.mark.asyncio
async def test_put_and_get_round_trip_binary_content(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/blob.bin", "wb") as f:
            await f.write(PAYLOAD)
        async with sftp.open("/blob.bin", "rb") as f:
            assert await f.read() == PAYLOAD
        assert (await sftp.stat("/blob.bin")).size == len(PAYLOAD)


@pytest.mark.asyncio
async def test_sftp_and_the_shell_see_one_tree(ssh):
    async with ssh.connect() as conn:
        await conn.run("mkdir -p /work && echo from-shell > /work/a.txt")
        async with conn.start_sftp_client() as sftp:
            async with sftp.open("/work/a.txt") as f:
                assert await f.read() == "from-shell\n"
            async with sftp.open("/work/b.txt", "w") as f:
                await f.write("from-sftp\n")
        result = await conn.run("cat /work/b.txt")
    assert result.stdout == "from-sftp\n"


@pytest.mark.asyncio
async def test_listing_stat_and_realpath(ssh):
    async with ssh.connect() as conn:
        await conn.run("mkdir -p /d/sub && echo x > /d/f")
        async with conn.start_sftp_client() as sftp:
            assert await sftp.realpath(".") == "/"
            assert await sftp.realpath("/d/../d/./sub") == "/d/sub"
            assert sorted(await sftp.listdir("/d")) == [".", "..", "f", "sub"]
            assert await sftp.isdir("/d/sub")
            assert await sftp.isfile("/d/f")
            with pytest.raises(asyncssh.SFTPNoSuchFile):
                await sftp.stat("/d/missing")


@pytest.mark.asyncio
async def test_the_host_filesystem_is_not_reachable(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        with pytest.raises(asyncssh.SFTPNoSuchFile):
            await sftp.stat("/etc/passwd")
        assert await sftp.realpath("/../../etc") == "/etc"


@pytest.mark.asyncio
async def test_mkdir_rename_remove_rmdir(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        await sftp.mkdir("/box")
        async with sftp.open("/box/one", "w") as f:
            await f.write("1")
        await sftp.rename("/box/one", "/box/two")
        assert await sftp.listdir("/box") == [".", "..", "two"]
        await sftp.remove("/box/two")
        await sftp.rmdir("/box")
        assert not await sftp.exists("/box")


@pytest.mark.asyncio
async def test_v3_rename_refuses_an_existing_target(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        for name in ("/a", "/b"):
            async with sftp.open(name, "w") as f:
                await f.write(name)
        with pytest.raises(asyncssh.SFTPError):
            await sftp.rename("/a", "/b")
        await sftp.posix_rename("/a", "/b")
        async with sftp.open("/b") as f:
            assert await f.read() == "/a"


@pytest.mark.asyncio
async def test_exclusive_create_refuses_an_existing_file(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/x", "w") as f:
            await f.write("x")
        with pytest.raises(asyncssh.SFTPError):
            await sftp.open("/x", "x")


@pytest.mark.asyncio
async def test_append_writes_at_the_end(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/log", "w") as f:
            await f.write("one\n")
        async with sftp.open("/log", "a") as f:
            await f.write("two\n")
        async with sftp.open("/log") as f:
            assert await f.read() == "one\ntwo\n"


@pytest.mark.asyncio
async def test_setstat_size_truncates(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/t", "w") as f:
            await f.write("abcdef")
        await sftp.truncate("/t", 3)
        async with sftp.open("/t") as f:
            assert await f.read() == "abc"


@pytest.mark.asyncio
async def test_symlink_and_readlink_round_trip(ssh):
    async with ssh.connect() as conn:
        await conn.run("echo target > /real")
        async with conn.start_sftp_client() as sftp:
            await sftp.symlink("/real", "/link")
            assert await sftp.readlink("/link") == "real"
            assert stat.S_ISLNK((await sftp.lstat("/link")).permissions)
            assert stat.S_ISREG((await sftp.stat("/link")).permissions)


@pytest.mark.asyncio
async def test_unsupported_ops_say_so(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/h", "w") as f:
            await f.write("h")
        with pytest.raises(asyncssh.SFTPOpUnsupported):
            await sftp.link("/h", "/h2")


@pytest.mark.asyncio
async def test_statvfs_answers(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        vfs = await sftp.statvfs("/")
    assert vfs.bsize > 0 and vfs.namemax == 255


@pytest.mark.asyncio
async def test_a_read_only_mount_refuses_writes(ssh_readonly):
    async with (
        ssh_readonly.connect() as conn,
        conn.start_sftp_client() as sftp,
    ):
        with pytest.raises(asyncssh.SFTPPermissionDenied):
            async with sftp.open("/nope", "w") as f:
                await f.write("x")


@pytest.mark.asyncio
async def test_unknown_workspace_serves_nothing(ssh):
    async with (
        ssh.connect(username="nope") as conn,
        conn.start_sftp_client() as sftp,
    ):
        with pytest.raises(asyncssh.SFTPNoSuchFile, match="nope"):
            await sftp.stat("/")


@pytest.mark.asyncio
async def test_the_sftp_channel_exits_zero(ssh):
    # OpenSSH's scp (in SFTP mode) fails a copy whose ssh exits non-zero,
    # and ssh exits 255 for a channel that closes with no exit status.
    async with ssh.connect() as conn:
        process = await conn.create_process(subsystem="sftp", encoding=None)
        process.stdin.write(FXP_INIT_V3)
        header = await asyncio.wait_for(process.stdout.readexactly(5), 5)
        assert header[4] == FXP_VERSION
        process.stdin.write_eof()
        await asyncio.wait_for(process.wait_closed(), 5)
    assert process.exit_status == 0


@pytest.mark.asyncio
async def test_sftp_session_is_closed_on_exit(ssh):
    async with ssh.connect() as conn:
        async with conn.start_sftp_client() as sftp:
            await sftp.stat("/")
        await asyncio.sleep(0.2)
    ids = [s.session_id for s in ssh.entry.runner.ws.list_sessions()]
    assert not [sid for sid in ids if sid.startswith("ssh_")]


@pytest.mark.asyncio
async def test_scp_reaches_the_workspace(ssh, tmp_path):
    local = tmp_path / "up.txt"
    local.write_text("scp payload\n")
    async with ssh.connect() as conn:
        await asyncssh.scp(str(local), (conn, "/up.txt"))
        await asyncssh.scp((conn, "/up.txt"), str(tmp_path / "down.txt"))
        result = await conn.run("cat /up.txt")
    assert result.stdout == "scp payload\n"
    assert (tmp_path / "down.txt").read_text() == "scp payload\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("directory", [False, True])
@pytest.mark.parametrize("posix", [False, True])
async def test_open_file_follows_rename(ssh, directory, posix):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        await sftp.mkdir("/old")
        async with sftp.open("/old/file", "w+") as f:
            await f.write("before")
            rename = sftp.posix_rename if posix else sftp.rename
            await rename("/old" if directory else "/old/file", "/new")
            await f.write("after", offset=6)
            await f.truncate(9)
            assert (await f.stat()).size == 9
            await f.seek(0)
            assert await f.read() == "beforeaft"
        target = "/new/file" if directory else "/new"
        async with sftp.open(target) as f:
            assert await f.read() == "beforeaft"
        assert not await sftp.exists("/old/file")


@pytest.mark.asyncio
async def test_refused_rename_keeps_the_open_file(ssh):
    async with ssh.connect() as conn, conn.start_sftp_client() as sftp:
        async with sftp.open("/taken", "w") as f:
            await f.write("untouched")
        async with sftp.open("/source", "w") as f:
            with pytest.raises(asyncssh.SFTPError):
                await sftp.rename("/source", "/taken")
            await f.write("retained")
        async with sftp.open("/source") as f:
            assert await f.read() == "retained"
        async with sftp.open("/taken") as f:
            assert await f.read() == "untouched"


@pytest.mark.asyncio
async def test_sftp_runs_under_the_key_profile(tmp_path):
    harness = await start_harness(tmp_path, await vault_workspace())
    guarded = bind_key(harness, 'mirage-profile="guarded"')
    try:
        async with harness.connect() as conn, conn.start_sftp_client() as sftp:
            async with sftp.open("/vault/secret", "rb") as f:
                content = await f.read()
        async with harness.connect(key=guarded) as conn:
            async with conn.start_sftp_client() as sftp:
                with pytest.raises(asyncssh.SFTPPermissionDenied):
                    async with sftp.open("/vault/secret", "rb") as f:
                        await f.read()
    finally:
        await stop_harness(harness)
    assert content == b"token\n"


@pytest.mark.asyncio
async def test_a_stat_does_not_follow_a_hidden_link(tmp_path):
    ws = Workspace(
        {"/": (RAMVFS(), MountMode.WRITE)},
        profiles={"hiding": {"paths": {"hide": ["/lnk"]}}},
    )
    await ws.shell("echo body > /a.txt && ln -s /a.txt /lnk")
    harness = await start_harness(tmp_path, ws)
    hiding = bind_key(harness, 'mirage-profile="hiding"')
    try:
        async with harness.connect() as conn, conn.start_sftp_client() as sftp:
            assert (await sftp.stat("/lnk")).size == len(b"body\n")
        async with harness.connect(key=hiding) as conn:
            async with conn.start_sftp_client() as sftp:
                with pytest.raises(asyncssh.SFTPNoSuchFile):
                    await sftp.stat("/lnk")
    finally:
        await stop_harness(harness)


class ListingCore:
    """MountCore double: hold the first batch until the cap is full."""

    def __init__(self, names, refuse=None):
        self.names = names
        self.refuse = refuse
        self.started = asyncio.Barrier(LISTING_CONCURRENCY)
        self.now = 0
        self.peak = 0
        self.calls = 0

    async def readdir(self, path):
        return [".", ".."] + self.names

    async def getattr(self, path):
        self.calls += 1
        self.now += 1
        self.peak = max(self.peak, self.now)
        try:
            if self.calls <= LISTING_CONCURRENCY:
                await asyncio.wait_for(self.started.wait(), 5)
            else:
                await asyncio.sleep(0)
        finally:
            self.now -= 1
        if path.endswith("gone"):
            raise FileNotFoundError(path)
        if self.refuse is not None and path.endswith(self.refuse):
            raise PermissionError(path)
        return {"st_size": len(path)}


@pytest.mark.asyncio
async def test_listing_stats_entries_together_under_the_cap():
    # Each stat is, on an unindexed mount, a backend request: a wide
    # directory must not pay them one after another, nor put them all on
    # the wire at once.
    names = [f"f{i}" for i in range(40)] + ["gone"]
    core = ListingCore(names)
    rows = await listing(core, "/d")
    assert [name for name, _ in rows] == [".", ".."] + names[:-1]
    assert rows[2] == ("f0", {"st_size": len("/d/f0")})
    assert core.peak == LISTING_CONCURRENCY


@pytest.mark.asyncio
async def test_listings_at_once_share_one_cap():
    # Two channels listing together on one workspace share the cap rather
    # than each bringing one of its own.
    core = ListingCore([f"f{i}" for i in range(40)])
    await asyncio.gather(listing(core, "/d"), listing(core, "/d"))
    assert core.peak == LISTING_CONCURRENCY


@pytest.mark.asyncio
async def test_a_refused_stat_ends_the_listing_without_statting_the_rest():
    core = ListingCore([f"f{i}" for i in range(100)], refuse="/d/f2")
    with pytest.raises(PermissionError):
        await listing(core, "/d")
    assert core.now == 0
    assert core.calls < 2 * LISTING_CONCURRENCY
