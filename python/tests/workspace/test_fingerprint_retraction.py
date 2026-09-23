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
from contextlib import contextmanager

import pytest

from mirage.types import DriftPolicy, MountMode
from mirage.vfs.s3 import S3VFS, S3Config
from mirage.workspace import Workspace
from mirage.workspace.snapshot.drift import ContentDriftError
from mirage.workspace.snapshot.state import to_state_dict
from tests.e2e.s3_mock import (MultiBucketS3Client, MultiBucketSession,
                               patch_s3_session)

BUCKET = "test-bucket"


def _config() -> S3Config:
    return S3Config(bucket=BUCKET,
                    region="us-east-1",
                    aws_access_key_id="fake",
                    aws_secret_access_key="fake")


@contextmanager
def _mounted(store: dict[str, bytes]):
    """Serve `store` as /s3 under a patched s3 session.

    Args:
        store (dict[str, bytes]): bucket contents, mutated in place so a
            test can change the object out of band.
    """
    session = MultiBucketSession({BUCKET: store}, etag_suffix="-2")
    with patch_s3_session(session):
        yield


def _ws() -> Workspace:
    return Workspace({"/s3": (S3VFS(_config()), MountMode.WRITE)},
                     mode=MountMode.WRITE)


def test_a_written_path_is_captured_for_drift():
    """#1018: the write stamps a token but capture used to ignore it, so
    an out-of-band change to a path mirage wrote went undetected."""
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> list[str]:
            ws = _ws()
            try:
                await (await ws.shell("tee /s3/x.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                state = await to_state_dict(ws)
                return [f["path"] for f in state["fingerprints"]]
            finally:
                await ws.close()

        assert asyncio.run(run()) == ["/s3/x.txt"]


def test_a_written_path_raises_on_a_strict_load_after_an_out_of_band_change():
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> None:
            ws = _ws()
            try:
                await (await ws.shell("tee /s3/x.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                state = await to_state_dict(ws)
            finally:
                await ws.close()
            store["x.txt"] = b"v2\n"
            loaded = await Workspace.from_state(
                state, mounts={"/s3": S3VFS(_config())})
            try:
                await loaded.shell("cat /s3/x.txt")
            finally:
                await loaded.close()

        with pytest.raises(ContentDriftError):
            asyncio.run(run())


def test_a_written_path_serves_current_state_under_drift_policy_off():
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> bytes:
            ws = _ws()
            try:
                await (await ws.shell("tee /s3/x.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                state = await to_state_dict(ws)
            finally:
                await ws.close()
            store["x.txt"] = b"v2\n"
            loaded = await Workspace.from_state(
                state,
                mounts={"/s3": S3VFS(_config())},
                drift_policy=DriftPolicy.OFF)
            try:
                io = await loaded.shell("cat /s3/x.txt")
                return await io.materialize_stdout()
            finally:
                await loaded.close()

        assert asyncio.run(run()) == b"v2\n"


def test_a_refused_removal_leaves_no_stale_bytes_for_a_strict_load(
        monkeypatch):
    """A delete the store refused before touching anything still retracts
    the pin, so the cached body has to go with it: left behind, a
    restored snapshot would serve the pre-change bytes with nothing left
    to check them, the hole #1018 reported."""
    store = {"x.txt": b"v1\n"}

    async def refuse(self, **kwargs):
        raise RuntimeError("AccessDenied")

    monkeypatch.setattr(MultiBucketS3Client, "delete_object", refuse)
    with _mounted(store):

        async def run() -> tuple[bytes, list[str], bytes]:
            ws = _ws()
            try:
                await (await ws.shell("cat /s3/x.txt")).materialize_stdout()
                rm = await (
                    await
                    ws.shell("rm /s3/x.txt; echo rm=$?")).materialize_stdout()
                state = await to_state_dict(ws)
            finally:
                await ws.close()
            assert store["x.txt"] == b"v1\n"
            store["x.txt"] = b"v2\n"
            loaded = await Workspace.from_state(
                state, mounts={"/s3": S3VFS(_config())})
            try:
                io = await loaded.shell("cat /s3/x.txt")
                return rm, [f["path"] for f in state["fingerprints"]
                            ], (await io.materialize_stdout())
            finally:
                await loaded.close()

        rm, pins, served = asyncio.run(run())

    assert rm == b"rm=1\n"
    assert pins == []
    assert served == b"v2\n"


def test_write_then_move_leaves_no_pin_to_fail_the_load():
    """The idiom that a naive widening would break: the temp path is
    pinned by the write and must be retracted by the move, or a STRICT
    load raises on a path the agent deliberately moved."""
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> tuple[list[str], bytes]:
            ws = _ws()
            try:
                await (await ws.shell(
                    "tee /s3/tmp.txt && mv /s3/tmp.txt /s3/final.txt",
                    stdin=b"v1\n")).materialize_stdout()
                state = await to_state_dict(ws)
            finally:
                await ws.close()
            loaded = await Workspace.from_state(
                state, mounts={"/s3": S3VFS(_config())})
            try:
                io = await loaded.shell("cat /s3/final.txt")
                return ([f["path"] for f in state["fingerprints"]], await
                        io.materialize_stdout())
            finally:
                await loaded.close()

        pins, served = asyncio.run(run())

    assert pins == []
    assert served == b"v1\n"


def test_a_strict_load_succeeds_when_the_written_object_is_unchanged():
    """The cheapest regression test for the whole write-pinning change:
    if a driver's put token and its head token ever disagreed, every
    STRICT load of a written path would fail and nothing else here would
    notice."""
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> bytes:
            ws = _ws()
            try:
                await (await ws.shell("tee /s3/x.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                state = await to_state_dict(ws)
            finally:
                await ws.close()
            loaded = await Workspace.from_state(
                state, mounts={"/s3": S3VFS(_config())})
            try:
                io = await loaded.shell("cat /s3/x.txt")
                return await io.materialize_stdout()
            finally:
                await loaded.close()

        assert asyncio.run(run()) == b"v1\n"


INNER = "inner-bucket"


def _inner_config() -> S3Config:
    return S3Config(bucket=INNER,
                    region="us-east-1",
                    aws_access_key_id="fake",
                    aws_secret_access_key="fake")


def test_a_subtree_retraction_spares_a_nested_mount():
    """The owner bounding, through the real registry rather than a stub.

    A nested mount's keys live in a different backend, so the outer
    mount's `rm -r` never touched them; an unbounded sweep would drop
    their pins and silently lose their drift check.
    """
    outer: dict[str, bytes] = {}
    inner: dict[str, bytes] = {}
    session = MultiBucketSession({
        BUCKET: outer,
        INNER: inner
    },
                                 etag_suffix="-2")
    with patch_s3_session(session):

        async def run() -> list[str]:
            ws = Workspace(
                {
                    "/s3": (S3VFS(_config()), MountMode.WRITE),
                    "/s3/d/inner": (S3VFS(_inner_config()), MountMode.WRITE),
                },
                mode=MountMode.WRITE)
            try:
                await (await ws.shell("tee /s3/d/x.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                await (await ws.shell("tee /s3/d/inner/y.txt",
                                      stdin=b"v1\n")).materialize_stdout()
                await ws.shell("rm -r /s3/d")
                state = await to_state_dict(ws)
                return sorted(f["path"] for f in state["fingerprints"])
            finally:
                await ws.close()

        assert asyncio.run(run()) == ["/s3/d/inner/y.txt"]


def test_moving_one_object_spares_an_independent_descendant_pin():
    """`a` and `a/child` are independent keys on a keyed store, so
    `mv a b` moves the single object at `a` and never touches `a/child`.

    The end-to-end case the unit tests could not see: both rename paths
    used to record the same op name, so capture treated a one-object
    move as a prefix move and dropped a pin for an object that had not
    moved.
    """
    store: dict[str, bytes] = {}
    with _mounted(store):

        async def run() -> tuple[list[str], list[str]]:
            ws = _ws()
            try:
                await (await ws.shell("tee /s3/a",
                                      stdin=b"A\n")).materialize_stdout()
                await (await ws.shell("tee /s3/a/child",
                                      stdin=b"C\n")).materialize_stdout()
                await ws.shell("mv /s3/a /s3/b")
                state = await to_state_dict(ws)
                return sorted(store), sorted(f["path"]
                                             for f in state["fingerprints"])
            finally:
                await ws.close()

        keys, pins = asyncio.run(run())
        assert keys == ["a/child", "b"]
        assert pins == ["/s3/a/child"]
