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
from tests.fixtures.google_account import UPLOAD_FILE, GoogleAccount

DOC_MIME = "application/vnd.google-apps.document"
RENDER = "GET /v1/documents/:id"


def _ws(account: GoogleAccount, policy: ReadPolicy | None) -> Workspace:
    """A gdrive mount at a prefixed mountpoint, reading under ``policy``.

    Args:
        account (GoogleAccount): the account it is signed in to.
        policy (ReadPolicy | None): its read policy; the default if None.
    """
    vfs = GoogleDriveVFS(account.config(GoogleDriveConfig))
    if policy is None:
        return Workspace({"/gd": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
    return Workspace(
        {"/gd": (vfs, MountMode.WRITE)},
        mode=MountMode.WRITE,
        read=ReadSpec(policy=policy),
    )


async def _requests(account: GoogleAccount) -> list[str]:
    """The name of each request made since recording started."""
    return [name for name, _ in await account.log()]


async def _write_doc(account: GoogleAccount, doc_id: str, text: str) -> None:
    """Add ``text`` at the start of a Doc's body, as a Docs client edits
    one; the edit moves the file's modifiedTime.

    Args:
        account (GoogleAccount): the account.
        doc_id (str): the Doc.
        text (str): what is written.
    """
    edit = {"insertText": {"location": {"index": 1}, "text": text}}
    await account.run.call(
        "POST",
        f"/v1/documents/{doc_id}:batchUpdate",
        json={"requests": [edit]},
    )


async def _doc(account: GoogleAccount, text: str) -> str:
    """A Doc named ``doc`` holding ``text``, and its id.

    Args:
        account (GoogleAccount): the account.
        text (str): its body.
    """
    made = await account.create("doc", DOC_MIME)
    await _write_doc(account, made, text)
    return made


@pytest.mark.asyncio
async def test_gdrive_under_fresh_sees_an_out_of_band_change(google_account):
    # The mount is allowed `fresh`, and an out-of-band change is seen: stat
    # and the read stamp one token, so a changed file compares unequal.
    made = await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    assert (
        await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
    ) == b"v1"
    await google_account.update(made, b"v2-external")
    got = await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
    assert got == b"v2-external"


@pytest.mark.asyncio
async def test_gdrive_under_fresh_does_not_refetch_an_unchanged_file(
    google_account,
):
    """The half that separates a working gate from a broken one.

    A broken label stores the entry with no token at all, and `is_fresh`
    answers False on a stored None -- so the mount evicts and refetches on
    every read and STILL returns the right bytes. Only an unchanged file
    tells the two apart: one download when the token matches, two when
    nothing was ever stamped.
    """
    await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await google_account.run.record_requests()
    await ws.shell("cat /gd/file.txt")
    # The positive control: without it the assertion below would also pass
    # if `cat` stopped downloading at all.
    assert (await _requests(google_account)).count("media") == 1
    await google_account.run.record_requests()
    assert (
        await (await ws.shell("cat /gd/file.txt")).materialize_stdout()
    ) == b"v1"
    assert (await _requests(google_account)).count("media") == 0, (
        "a warm read whose token still matches must serve from cache"
    )


@pytest.mark.asyncio
async def test_a_native_gdoc_under_fresh_renders_once_until_it_changes(
    google_account,
):
    # A native file has no md5 and no head revision; its token is the
    # listing's modifiedTime, and it reaches the cache only through the
    # native read's own record.
    made = await _doc(google_account, "v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await google_account.run.record_requests()
    first = await (
        await ws.shell("cat /gd/doc.gdoc.json")
    ).materialize_stdout()
    # The positive control: the warm assertion below needs this to mean
    # anything.
    assert (await _requests(google_account)).count(RENDER) == 1
    second = await (
        await ws.shell("cat /gd/doc.gdoc.json")
    ).materialize_stdout()
    warm_renders = (await _requests(google_account)).count(RENDER) - 1
    await _write_doc(google_account, made, "v2 ")
    third = await (
        await ws.shell("cat /gd/doc.gdoc.json")
    ).materialize_stdout()
    # The refetch has to stamp the new token, or every later read renders.
    fourth = await (
        await ws.shell("cat /gd/doc.gdoc.json")
    ).materialize_stdout()
    assert first == second
    assert third == fourth
    assert b"v2 v1" in third
    assert b"v2 v1" not in first
    assert warm_renders == 0
    assert (await _requests(google_account)).count(RENDER) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path,listings", [("file.txt", 1), ("a/b/c/file.txt", 4)]
)
async def test_a_warm_gdrive_read_costs_one_walk_per_probe(
    google_account, path, listings
):
    """Cost is the contract, and the operand probe is the cost.

    A warm named operand is probed at the command's first lookup of it,
    with a fresh index, so the probe walks the parent listings: one per
    level. The command's own stat and the gate both reuse that answer for
    the rest of the command instead of asking again. More means one of
    them reached the backend again; zero downloads is the other half.
    """
    await google_account.put(path, b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await ws.shell(f"cat /gd/{path}")
    await google_account.run.record_requests()
    await ws.shell(f"cat /gd/{path}")
    assert len(await google_account.listings()) == listings
    assert (await _requests(google_account)).count("media") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["file.txt", "doc.gdoc.json"])
async def test_a_warm_fresh_stat_prints_what_a_bounded_one_does(
    google_account, path
):
    # The command's stat now comes from the freshness probe rather than from
    # the command's own lookup; what it prints must not change with it.
    async def warm_stat(ws) -> bytes:
        await ws.shell(f"cat /gd/{path}")
        result = await ws.shell(f"stat /gd/{path}")
        return await result.materialize_stdout()

    await google_account.upload("file.txt", b"v1")
    await _doc(google_account, "v1")
    fresh_out = await warm_stat(_ws(google_account, ReadPolicy.FRESH))
    bounded_out = await warm_stat(_ws(google_account, None))
    assert fresh_out == bounded_out
    assert fresh_out


@pytest.mark.asyncio
async def test_a_gdrive_read_reaches_snapshot_capture(google_account):
    # `capture_fingerprints` skips a record whose path resolves to no mount,
    # so a read that recorded anything but the virtual path would leave the
    # snapshot silently empty.
    await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await ws.shell("cat /gd/file.txt")
    entries = capture_fingerprints(ws._files.records, ws._registry)
    paths = [e[FingerprintKey.PATH] for e in entries]
    assert "/gd/file.txt" in paths


@pytest.mark.asyncio
async def test_a_captured_gdrive_read_carries_a_revision(google_account):
    # A revision pin REPLACES the drift check rather than adding to it:
    # `install_fingerprints` stops at the revision and never queues the
    # check, so a binary gdrive path in a snapshot gets pinned replay.
    await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await ws.shell("cat /gd/file.txt")
    entries = capture_fingerprints(ws._files.records, ws._registry)
    entry = next(
        e for e in entries if e[FingerprintKey.PATH] == "/gd/file.txt"
    )
    assert entry.get(FingerprintKey.REVISION) is not None


@pytest.mark.asyncio
async def test_a_written_gdrive_path_pins_the_write_token_and_replays(
    google_account,
):
    # The read's pin carries a revision; the write after it must replace
    # that pin whole with the upload reply's md5, so a replay checks the
    # written bytes rather than pinning the pre-write revision.
    made = await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.FRESH)
    await google_account.run.record_requests()
    await ws.shell("cat /gd/file.txt; echo x | tee /gd/file.txt")
    assert len(await google_account.asked("PATCH", UPLOAD_FILE)) == 1
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
    await google_account.update(made, b"changed")
    with pytest.raises(ContentDriftError):
        await check_drift(ws._registry.try_mount_for, "/gd/file.txt", recorded)


@pytest.mark.asyncio
async def test_gdrive_bounded_may_serve_stale(google_account):
    made = await google_account.upload("file.txt", b"v1")
    ws = _ws(google_account, ReadPolicy.BOUNDED)
    await ws.shell("ls /gd")
    io1 = await ws.shell("cat /gd/file.txt")
    assert (await io1.materialize_stdout()) == b"v1"

    await google_account.update(made, b"v2-external")

    io2 = await ws.shell("cat /gd/file.txt")
    got = await io2.materialize_stdout()
    assert got in (b"v1", b"v2-external"), (
        "LAZY allowed to serve cache; just confirming no crash"
    )
