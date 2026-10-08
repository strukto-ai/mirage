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

import hashlib

import pytest

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from mirage.workspace.snapshot.drift import (
    ContentDriftError,
    capture_fingerprints,
    check_drift,
)
from mirage.workspace.snapshot.keys import FingerprintKey
from tests.e2e.gdrive_mock import FakeGDrive, patch_gdrive


def _fresh_ws():
    """A `read: fresh` gdrive mount at a prefixed mountpoint.

    The fake is not passed in: `patch_gdrive` at the call site is what
    backs the mount, and taking it here would suggest otherwise.
    """
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    return Workspace(
        {"/gd": (GoogleDriveVFS(config), MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.FRESH),
    )


@pytest.mark.asyncio
async def test_gdrive_under_fresh_sees_an_out_of_band_change():
    # The mount is allowed `fresh`, and an out-of-band change is seen: stat
    # and the read stamp one token, so a changed file compares unequal.
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        assert (
            await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
        ) == b"v1"
        fake.add_file("file.txt", b"v2-external")
        got = await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
    assert got == b"v2-external"


@pytest.mark.asyncio
async def test_gdrive_under_fresh_does_not_refetch_an_unchanged_file():
    """The half that separates a working gate from a broken one.

    A broken label stores the entry with no token at all, and `is_fresh`
    answers False on a stored None -- so the mount evicts and refetches on
    every read and STILL returns the right bytes. Only an unchanged file
    tells the two apart: one download when the token matches, two when
    nothing was ever stamped.
    """
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell("cat /gd/file.txt")
        # The positive control: a Counter answers 0 for a key nobody
        # increments, so without this the assertion below would also pass if
        # `cat` stopped routing through the counted download entirely.
        assert fake.calls["download_file"] == 1
        fake.calls.clear()
        assert (
            await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
        ) == b"v1"
    assert fake.calls["download_file"] == 0, (
        "a warm read whose token still matches must serve from cache"
    )


@pytest.mark.asyncio
async def test_a_native_gdoc_under_fresh_renders_once_until_it_changes():
    # A native file has no md5 and no head revision; its token is the
    # listing's modifiedTime, and it reaches the cache only through the
    # native read's own record.
    fake = FakeGDrive()
    fake.add_file(
        "doc", b'{"v": 1}', mime="application/vnd.google-apps.document"
    )
    ws = _fresh_ws()
    with patch_gdrive(fake):
        first = await (
            await ws.shell("cat /gd/doc.gdoc.json")
        ).materialize_stdout()
        # The positive control: a Counter answers 0 for a key nobody
        # increments, so the warm assertion below needs this to mean anything.
        assert fake.calls["render"] == 1
        second = await (
            await ws.shell("cat /gd/doc.gdoc.json")
        ).materialize_stdout()
        warm_renders = fake.calls["render"] - 1
        fake.add_file("doc", b'{"v": 2}')
        fake.set_modified("doc", "2026-05-01T00:00:00Z")
        third = await (
            await ws.shell("cat /gd/doc.gdoc.json")
        ).materialize_stdout()
        # The refetch has to stamp the new token, or every later read renders.
        fourth = await (
            await ws.shell("cat /gd/doc.gdoc.json")
        ).materialize_stdout()
    assert (first, second, third, fourth) == (
        b'{"v": 1}',
        b'{"v": 1}',
        b'{"v": 2}',
        b'{"v": 2}',
    )
    assert warm_renders == 0
    assert fake.calls["render"] == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,listings", [("file.txt", 1), ("a/b/c/file.txt", 4)]
)
async def test_a_warm_gdrive_read_costs_one_walk_per_probe(path, listings):
    """Cost is the contract, and the routing probe is the cost.

    A warm named operand is probed at routing, with a fresh index, so the
    probe walks the parent listings: one per level. The command's own stat
    and the gate both reuse that answer for the rest of the command instead
    of asking again. More means one of them reached the backend again; zero
    downloads is the other half.
    """
    fake = FakeGDrive()
    fake.add_file(path, b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell(f"cat /gd/{path}")
        fake.calls.clear()
        await ws.shell(f"cat /gd/{path}")
    assert fake.calls["list_files"] == listings
    assert fake.calls["download_file"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["file.txt", "doc.gdoc.json"])
async def test_a_warm_fresh_stat_prints_what_a_bounded_one_does(path):
    # The command's stat now comes from the freshness probe rather than from
    # the command's own lookup; what it prints must not change with it.
    async def warm_stat(ws) -> bytes:
        await ws.shell(f"cat /gd/{path}")
        result = await ws.shell(f"stat /gd/{path}")
        return await result.materialize_stdout()

    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    fake.add_file(
        "doc", b'{"v": 1}', mime="application/vnd.google-apps.document"
    )
    bounded = Workspace(
        {
            "/gd": (
                GoogleDriveVFS(
                    GoogleDriveConfig(
                        client_id="fake-id",
                        client_secret="fake-secret",
                        refresh_token="fake-refresh",
                    )
                ),
                MountMode.WRITE,
            )
        },
        mode=MountMode.WRITE,
    )
    with patch_gdrive(fake):
        fresh_out = await warm_stat(_fresh_ws())
        bounded_out = await warm_stat(bounded)
    assert fresh_out == bounded_out
    assert fresh_out


@pytest.mark.asyncio
async def test_a_gdrive_read_reaches_snapshot_capture():
    # `capture_fingerprints` skips a record whose path resolves to no mount,
    # so a read that recorded anything but the virtual path would leave the
    # snapshot silently empty.
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell("cat /gd/file.txt")
        entries = capture_fingerprints(ws._files.records, ws._registry)
    paths = [e[FingerprintKey.PATH] for e in entries]
    assert "/gd/file.txt" in paths


@pytest.mark.asyncio
async def test_a_captured_gdrive_read_carries_a_revision():
    # A revision pin REPLACES the drift check rather than adding to it:
    # `install_fingerprints` stops at the revision and never queues the
    # check, so a binary gdrive path in a snapshot gets pinned replay.
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell("cat /gd/file.txt")
        entries = capture_fingerprints(ws._files.records, ws._registry)
    entry = next(
        e for e in entries if e[FingerprintKey.PATH] == "/gd/file.txt"
    )
    assert entry.get(FingerprintKey.REVISION) is not None


@pytest.mark.asyncio
async def test_a_written_gdrive_path_pins_the_write_token_and_replays():
    # The read's pin carries a revision; the write after it must replace
    # that pin whole with the upload reply's md5, so a replay checks the
    # written bytes rather than pinning the pre-write revision.
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell("cat /gd/file.txt; echo x | tee /gd/file.txt")
        assert fake.calls["update_file_content"] == 1
        pins = {
            e[FingerprintKey.PATH]: e
            for e in capture_fingerprints(ws._files.records, ws._registry)
        }
        assert pins.get("/gd/file.txt") == {
            FingerprintKey.PATH: "/gd/file.txt",
            FingerprintKey.MOUNT_PREFIX: "/gd/",
            FingerprintKey.FINGERPRINT: hashlib.md5(b"x\n").hexdigest(),
        }
        recorded = pins["/gd/file.txt"][FingerprintKey.FINGERPRINT]
        await check_drift(ws._registry.try_mount_for, "/gd/file.txt", recorded)
        fake.add_file("file.txt", b"changed")
        with pytest.raises(ContentDriftError):
            await check_drift(
                ws._registry.try_mount_for, "/gd/file.txt", recorded
            )


@pytest.mark.asyncio
async def test_gdrive_bounded_may_serve_stale():
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    config = GoogleDriveConfig(
        client_id="fake-id",
        client_secret="fake-secret",
        refresh_token="fake-refresh",
    )
    vfs = GoogleDriveVFS(config)
    ws = Workspace(
        {"/gd": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=ReadPolicy.BOUNDED),
    )
    with patch_gdrive(fake):
        await ws.shell("ls /gd")
        io1 = await ws.shell("cat /gd/file.txt")
        assert (await io1.materialize_stdout()) == b"v1"

        fake.add_file("file.txt", b"v2-external")

        io2 = await ws.shell("cat /gd/file.txt")
        got = await io2.materialize_stdout()
        assert got in (b"v1", b"v2-external"), (
            "LAZY allowed to serve cache; just confirming no crash"
        )
