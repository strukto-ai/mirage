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

from mirage.core.hf_buckets.read import read
from mirage.core.hf_buckets.readdir import readdir
from mirage.core.hf_buckets.stat import stat
from mirage.core.hf_hub.client import HfHubError
from mirage.types import FileType, PathSpec


@pytest.mark.asyncio
async def test_stat_file_stamps_the_paths_info_xet_hash(make_acc, bucket):
    acc = await make_acc({"data/file.txt": b"abcde"})
    row = await bucket.row("data/file.txt")
    await bucket.run.record_requests()
    s = await stat(acc, PathSpec.from_str_path("/data/file.txt"))
    assert s.name == "file.txt"
    assert s.size == 5
    # The same value the download's ETag carries, so a read can match it
    # (measured 2026-09-25); opendal reports no token for a bucket.
    assert s.fingerprint == row["xetHash"]
    assert s.extra == {"etag": row["xetHash"]}
    assert s.modified is None
    assert s.type != FileType.DIRECTORY
    assert (
        await bucket.count("paths_info"),
        await bucket.count("stat"),
        await bucket.count("opendal_read"),
    ) == (1, 0, 0)


@pytest.mark.asyncio
async def test_stat_directory_via_dir_probe(make_acc, bucket):
    acc = await make_acc({"data/file.txt": b"x"})
    s = await stat(acc, PathSpec.from_str_path("/data"))
    assert s.type == FileType.DIRECTORY
    assert s.name == "data"
    # paths-info answers [] for a directory; the listing probe decides.
    assert await bucket.count("stat") == 0


@pytest.mark.asyncio
async def test_stat_missing_raises_filenotfound(make_acc):
    acc = await make_acc({})
    with pytest.raises(FileNotFoundError):
        await stat(acc, PathSpec.from_str_path("/missing.txt"))


@pytest.mark.asyncio
async def test_stat_root_is_directory(make_acc):
    acc = await make_acc({})
    s = await stat(acc, PathSpec.from_str_path("/"))
    assert s.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_size_matches_read_for_every_file(make_acc):
    acc = await make_acc(
        {
            "poem.txt": b"a rose is a rose",
            "empty.txt": b"",
            "data/sub/nested.txt": b"deep",
        }
    )
    pending = ["/"]
    while pending:
        directory = pending.pop()
        for row in await readdir(acc, PathSpec.from_str_path(directory)):
            child = f"{directory.rstrip('/')}/{row.name}"
            st = await stat(acc, PathSpec.from_str_path(child))
            assert st.size == row.size
            if st.type == FileType.DIRECTORY:
                pending.append(child)
                continue
            data = await read(acc, PathSpec.from_str_path(child))
            assert st.size == len(data)


# paths-info never 404s for a missing path (it answers []), so every
# refusal here is about the bucket. An anonymous caller asking for a
# bucket that does not exist gets 401 (measured 2026-09-25); a 404 with a
# valid token was not measured and is mapped the same conservative way.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,code", [(401, ""), (403, ""), (404, "RepoNotFound")]
)
async def test_a_refused_bucket_is_permission_denied_never_absent(
    make_acc, bucket, status, code
):
    acc = await make_acc({"a.txt": b"x"})
    await bucket.refuse("paths_info", status, code)
    with pytest.raises(PermissionError):
        await stat(acc, PathSpec.from_str_path("/a.txt"))


@pytest.mark.asyncio
async def test_a_hub_fault_on_stat_stays_a_hub_error(make_acc, bucket):
    # 400 rather than a 5xx, which the client retries with backoff.
    acc = await make_acc({"a.txt": b"x"})
    await bucket.refuse("paths_info", 400)
    with pytest.raises(HfHubError):
        await stat(acc, PathSpec.from_str_path("/a.txt"))


@pytest.mark.asyncio
async def test_stat_under_a_key_prefix_reads_the_prefixed_object(
    make_acc, bucket
):
    acc = await make_acc(
        {"pfx/a.txt": b"seed", "a.txt": b"decoy"}, key_prefix="pfx/"
    )
    s = await stat(acc, PathSpec.from_str_path("/a.txt"))
    assert s.fingerprint == (await bucket.row("pfx/a.txt"))["xetHash"]
    assert s.fingerprint != (await bucket.row("a.txt"))["xetHash"]
