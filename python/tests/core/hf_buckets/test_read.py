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

from mirage.core.hf_buckets.read import read_bytes
from mirage.core.hf_hub.client import HfHubError
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from tests.fixtures.hf_hub_api import NO_ETAG, xet_hash

SEED = b"name,age\nalice,30\n"


async def _stamped(acc, path: str, **window) -> tuple[bytes, list]:
    scope = RecordingScope()
    try:
        out = await read_bytes(acc, PathSpec.from_str_path(path), **window)
    finally:
        scope.close()
    return out, [r.fingerprint for r in scope.records]


@pytest.mark.asyncio
async def test_read_bytes_whole_file(make_acc):
    acc = make_acc({"greet.txt": b"hello world"})
    out = await read_bytes(acc, PathSpec.from_str_path("/greet.txt"))
    assert out == b"hello world"


@pytest.mark.asyncio
async def test_read_bytes_offset_size_returns_slice(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=2, size=4)
    assert out == b"cdef"


@pytest.mark.asyncio
async def test_read_bytes_missing_raises_filenotfound(make_acc):
    acc = make_acc({})
    with pytest.raises(FileNotFoundError):
        await read_bytes(acc, PathSpec.from_str_path("/nope"))


@pytest.mark.asyncio
async def test_read_bytes_offset_only(make_acc):
    acc = make_acc({"x": b"abcdef"})
    out = await read_bytes(acc, PathSpec.from_str_path("/x"), offset=3)
    assert out == b"def"


@pytest.mark.asyncio
async def test_read_records_the_virtual_path(make_acc):
    # A key named like its mount: neither m/k.txt nor /m/k.txt is virtual.
    acc = make_acc({"m/k.txt": b"hello"})
    spec = PathSpec(virtual="/m/m/k.txt",
                    directory="/m/m/",
                    vfs_path="m/k.txt")
    scope = RecordingScope()
    try:
        out = await read_bytes(acc, spec)
    finally:
        scope.close()
    assert out == b"hello"
    assert [r.path for r in scope.records] == ["/m/m/k.txt"]


@pytest.mark.asyncio
@pytest.mark.parametrize("window,expected", [({}, SEED),
                                             ({
                                                 "offset": 5,
                                                 "size": 3
                                             }, SEED[5:8])])
async def test_a_read_stamps_the_download_etag(make_acc, fake_hub, window,
                                               expected):
    acc = make_acc({"a.txt": SEED})
    acc._fake.reach = []
    out, stamps = await _stamped(acc, "/a.txt", **window)
    assert out == expected
    # The strong ETag the bytes came with is the xet hash stat reports, for
    # a ranged 206 as for a whole read (measured 2026-09-25).
    assert stamps == [xet_hash(SEED)]
    assert (fake_hub.count("bucket_resolve"),
            fake_hub.count("bucket_paths_info")) == (1, 0)
    assert acc._fake.reach == []


@pytest.mark.asyncio
@pytest.mark.parametrize("served,stamp", [
    ('"other"', "other"),
    (f'W/"{xet_hash(SEED)}"', None),
    ('""', None),
    (NO_ETAG, None),
])
async def test_the_stamp_is_the_responses_own_strong_etag(
        make_acc, fake_hub, served, stamp):
    # "other" proves the token rides the read itself rather than a second
    # request; a weak validator does not vouch for bytes, and an empty or
    # missing one stamps nothing rather than "".
    fake_hub.etags["a.txt"] = served
    acc = make_acc({"a.txt": SEED})
    _, stamps = await _stamped(acc, "/a.txt")
    assert stamps == [stamp]


@pytest.mark.asyncio
@pytest.mark.parametrize("status,code,raised", [
    (404, "EntryNotFound", FileNotFoundError),
    (404, "", HfHubError),
    (401, "", PermissionError),
    (403, "", PermissionError),
    (400, "", HfHubError),
])
async def test_only_a_missing_entry_is_absent(make_acc, fake_hub, status, code,
                                              raised):
    # A 404 without EntryNotFound (a CDN or bucket-level one) must not read
    # as a deleted file: reconcile would drop the overlay for it.
    acc = make_acc({"a.txt": SEED})
    fake_hub.fail["bucket_resolve"] = (status, code)
    with pytest.raises(raised) as info:
        await read_bytes(acc, PathSpec.from_str_path("/a.txt"))
    # The raw error must not be an OSError either: every file tool reads
    # an OSError as a per-path verdict.
    assert not isinstance(info.value, OSError) if raised is HfHubError \
        else type(info.value) is raised


@pytest.mark.asyncio
async def test_the_mount_root_is_a_directory_even_under_a_prefix(
        make_acc, fake_hub):
    # The prefix stem is itself a readable file; a read of the mount root
    # must not serve it.
    acc = make_acc({"pfx": b"stem", "pfx/a.txt": SEED}, key_prefix="pfx/")
    with pytest.raises(IsADirectoryError):
        await read_bytes(acc, PathSpec.from_str_path("/"))
    assert fake_hub.count("bucket_resolve") == 0


@pytest.mark.asyncio
async def test_a_directory_key_read_directly_is_absent(make_acc):
    # resolve on a directory key answers 404 EntryNotFound (measured
    # 2026-09-25).
    acc = make_acc({"d/x.txt": b"x"})
    with pytest.raises(FileNotFoundError):
        await read_bytes(acc, PathSpec.from_str_path("/d"))


@pytest.mark.asyncio
async def test_a_window_past_eof_is_empty_and_stamps_nothing(
        make_acc, fake_hub):
    acc = make_acc({"a.txt": b"abc"})
    out, stamps = await _stamped(acc, "/a.txt", offset=99, size=5)
    assert (out, stamps) == (b"", [None])
    # The Hub answers 416 here (measured 2026-09-25); the fold is the
    # read's own, since a caller reading the range directly has no other.
    assert ("bucket_cdn", 416) in fake_hub.statuses
    short, _ = await _stamped(acc, "/a.txt", offset=0, size=100)
    assert short == b"abc"


@pytest.mark.asyncio
async def test_a_prefixed_read_serves_the_prefixed_object(make_acc):
    acc = make_acc({"pfx/a.txt": SEED, "a.txt": b"decoy"}, key_prefix="pfx/")
    assert await read_bytes(acc, PathSpec.from_str_path("/a.txt")) == SEED
    assert await read_bytes(acc,
                            PathSpec.from_str_path("/a.txt"),
                            offset=5,
                            size=3) == SEED[5:8]
    # A write through opendal lands where an HTTP read looks.
    await acc._fake.write("b.txt", b"written")
    assert acc._fake.files["pfx/b.txt"] == b"written"
    assert await read_bytes(acc,
                            PathSpec.from_str_path("/b.txt")) == b"written"


@pytest.mark.asyncio
async def test_a_name_that_needs_encoding_reads_whole(make_acc):
    acc = make_acc({"dir/Inkling_o (1)#.png": SEED})
    assert await read_bytes(
        acc, PathSpec.from_str_path("/dir/Inkling_o (1)#.png")) == SEED


@pytest.mark.asyncio
async def test_a_zero_length_window_is_empty_but_still_checks_the_file(
        make_acc, fake_hub):
    # The VFS range door reaches here with no factory short-circuit, and a
    # zero-length Range header is not one the client can build; the read
    # still has to say whether the file is there, as opendal's open did.
    acc = make_acc({"a.txt": SEED})
    assert await read_bytes(acc,
                            PathSpec.from_str_path("/a.txt"),
                            offset=3,
                            size=0) == b""
    assert fake_hub.count("bucket_resolve") == 1
    with pytest.raises(FileNotFoundError):
        await read_bytes(acc,
                         PathSpec.from_str_path("/missing.txt"),
                         offset=0,
                         size=0)
