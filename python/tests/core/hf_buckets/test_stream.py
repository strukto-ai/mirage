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

from mirage.core.hf_buckets.stream import range_read, read_stream
from mirage.core.hf_hub.client import HfHubError
from mirage.observe.context import RecordingScope, active_recorder
from mirage.types import PathSpec
from tests.fixtures.hf_hub_api import NO_ETAG, xet_hash

BIG = (b"x" * 1023 + b"\n") * 300


@pytest.mark.asyncio
async def test_range_read_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await range_read(acc, PathSpec.from_str_path("/x"), 1, 4)
    assert out == b"bcd"


@pytest.mark.asyncio
async def test_read_stream_yields_chunks(make_acc):
    acc = make_acc({"x": b"abcdefgh"})
    chunks = []
    async for c in read_stream(acc, PathSpec.from_str_path("/x"),
                               chunk_size=3):
        chunks.append(c)
    assert b"".join(chunks) == b"abcdefgh"
    assert len(chunks) >= 2


@pytest.mark.asyncio
async def test_read_stream_handles_empty_file(make_acc):
    acc = make_acc({"empty": b""})
    chunks = [
        c async for c in read_stream(acc, PathSpec.from_str_path("/empty"))
    ]
    assert b"".join(chunks) == b""


@pytest.mark.asyncio
async def test_stream_records_the_virtual_path(make_acc):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    acc = make_acc({"m/k.txt": b"hello"})
    spec = PathSpec(virtual="/m/m/k.txt",
                    directory="/m/m/",
                    vfs_path="m/k.txt")
    scope = RecordingScope()
    try:
        chunks = [c async for c in read_stream(acc, spec)]
    finally:
        scope.close()
    assert b"".join(chunks) == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


@pytest.mark.asyncio
async def test_a_stream_is_stamped_before_its_first_chunk(make_acc):
    acc = make_acc({"big.bin": BIG})
    acc._fake.reach = []
    scope = RecordingScope()
    try:
        chunks = read_stream(acc,
                             PathSpec.from_str_path("/big.bin"),
                             chunk_size=1024)
        first = await anext(chunks)
        # Stamped while suspended at the first yield: a consumer that stops
        # here (head -c) still leaves a record that names the bytes.
        assert [r.fingerprint for r in scope.records] == [xet_hash(BIG)]
        rest = [c async for c in chunks]
    finally:
        scope.close()
    assert first + b"".join(rest) == BIG
    assert acc._fake.reach == []


@pytest.mark.asyncio
async def test_an_empty_stream_is_still_stamped(make_acc):
    acc = make_acc({"empty": b""})
    scope = RecordingScope()
    try:
        assert [
            c async for c in read_stream(acc, PathSpec.from_str_path("/empty"))
        ] == []
    finally:
        scope.close()
    assert [r.fingerprint for r in scope.records] == [xet_hash(b"")]


@pytest.mark.asyncio
async def test_a_stream_with_no_recorder_does_not_crash(make_acc):
    acc = make_acc({"x": b"abc"})
    assert active_recorder() is None
    assert b"".join([
        c async for c in read_stream(acc, PathSpec.from_str_path("/x"))
    ]) == b"abc"


@pytest.mark.asyncio
@pytest.mark.parametrize("served", ['W/"abc"', NO_ETAG])
async def test_a_stream_without_a_strong_etag_stamps_nothing(
        make_acc, fake_hub, served):
    fake_hub.etags["x"] = served
    acc = make_acc({"x": b"abc"})
    scope = RecordingScope()
    try:
        _ = [c async for c in read_stream(acc, PathSpec.from_str_path("/x"))]
    finally:
        scope.close()
    assert [r.fingerprint for r in scope.records] == [None]


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code,raised", [
    (404, "EntryNotFound", FileNotFoundError),
    (404, "", HfHubError),
    (401, "", PermissionError),
    (403, "", PermissionError),
    (400, "", HfHubError),
])
async def test_a_stream_is_absent_only_for_a_missing_entry(
        make_acc, fake_hub, status, code, raised):
    acc = make_acc({"a.txt": b"abc"})
    fake_hub.fail["bucket_resolve"] = (status, code)
    with pytest.raises(raised) as info:
        _ = [
            c async for c in read_stream(acc, PathSpec.from_str_path("/a.txt"))
        ]
    assert not isinstance(info.value, OSError) if raised is HfHubError \
        else type(info.value) is raised


@pytest.mark.asyncio
async def test_a_stream_of_the_mount_root_is_a_directory(make_acc, fake_hub):
    acc = make_acc({"pfx": b"stem", "pfx/a.txt": b"a"}, key_prefix="pfx/")
    with pytest.raises(IsADirectoryError):
        _ = [c async for c in read_stream(acc, PathSpec.from_str_path("/"))]
    assert fake_hub.count("bucket_resolve") == 0


@pytest.mark.asyncio
async def test_a_prefixed_stream_serves_the_prefixed_object(make_acc):
    acc = make_acc({
        "pfx/a.txt": b"seed",
        "a.txt": b"decoy"
    },
                   key_prefix="pfx/")
    assert b"".join([
        c async for c in read_stream(acc, PathSpec.from_str_path("/a.txt"))
    ]) == b"seed"
    assert await range_read(acc, PathSpec.from_str_path("/a.txt"), 1,
                            3) == b"ee"
