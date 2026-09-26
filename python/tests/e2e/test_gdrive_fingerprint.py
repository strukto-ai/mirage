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

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.gdrive import GoogleDriveConfig, GoogleDriveVFS
from mirage.workspace import Workspace
from mirage.workspace.snapshot.drift import capture_fingerprints
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
        assert (await
                (await
                 ws.shell("cat /gd/file.txt")).materialize_stdout()) == b"v1"
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
        assert (await
                (await
                 ws.shell("cat /gd/file.txt")).materialize_stdout()) == b"v1"
    assert fake.calls["download_file"] == 0, (
        "a warm read whose token still matches must serve from cache")


@pytest.mark.asyncio
async def test_a_native_gdoc_under_fresh_renders_once_until_it_changes():
    # A native file has no md5 and no head revision; its token is the
    # listing's modifiedTime, and it reaches the cache only through the
    # native read's own record.
    fake = FakeGDrive()
    fake.add_file("doc",
                  b'{"v": 1}',
                  mime="application/vnd.google-apps.document")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        first = await (await
                       ws.shell("cat /gd/doc.gdoc.json")).materialize_stdout()
        # The positive control: a Counter answers 0 for a key nobody
        # increments, so the warm assertion below needs this to mean anything.
        assert fake.calls["render"] == 1
        second = await (
            await ws.shell("cat /gd/doc.gdoc.json")).materialize_stdout()
        warm_renders = fake.calls["render"] - 1
        fake.add_file("doc", b'{"v": 2}')
        fake.set_modified("doc", "2026-05-01T00:00:00Z")
        third = await (await
                       ws.shell("cat /gd/doc.gdoc.json")).materialize_stdout()
        # The refetch has to stamp the new token, or every later read renders.
        fourth = await (
            await ws.shell("cat /gd/doc.gdoc.json")).materialize_stdout()
    assert (first, second, third, fourth) == (b'{"v": 1}', b'{"v": 1}',
                                              b'{"v": 2}', b'{"v": 2}')
    assert warm_renders == 0
    assert fake.calls["render"] == 2


@pytest.mark.asyncio
async def test_a_warm_gdrive_read_costs_two_parent_listings():
    """Cost is the contract, and the gate's probes are the cost.

    A warm named operand is probed twice -- once at routing and once at the
    gate -- and each probe stats with a fresh index, so each warms through
    the parent listing. One means the gate stopped revalidating a named
    warm operand; zero downloads is the other half.
    """
    fake = FakeGDrive()
    fake.add_file("file.txt", b"v1")
    ws = _fresh_ws()
    with patch_gdrive(fake):
        await ws.shell("cat /gd/file.txt")
        fake.calls.clear()
        await ws.shell("cat /gd/file.txt")
    assert fake.calls["list_files"] == 2, (
        "routing reconcile + the gate's probe; one means the gate no longer "
        "revalidates a named warm operand")
    assert fake.calls["download_file"] == 0


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
        entries = capture_fingerprints(ws)
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
        entries = capture_fingerprints(ws)
    entry = next(e for e in entries
                 if e[FingerprintKey.PATH] == "/gd/file.txt")
    assert entry.get(FingerprintKey.REVISION) is not None


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
            "LAZY allowed to serve cache; just confirming no crash")
