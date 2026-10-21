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


from mirage.cache.file import io as cache_io
from mirage.observe.record import OpRecord


def _record(
    op: str, path: str, fingerprint: str | None, nbytes: int = 0
) -> OpRecord:
    return OpRecord(
        op=op,
        path=path,
        source="s3",
        bytes=nbytes,
        timestamp=0,
        duration_ms=0,
        fingerprint=fingerprint,
    )


def test_latest_fingerprint_reads_only_reads():
    # A write's own record labels the bytes it sent; here it would stamp
    # the write's token onto bytes a read produced, and the entry would
    # read as fresh forever.
    records = [
        _record("read", "/s3/f.txt", "etag-1", 3),
        _record("write", "/s3/f.txt", "etag-2", 3),
        _record("readdir", "/s3/f.txt", "etag-3", 3),
    ]
    assert cache_io.latest_fingerprint(records, "/s3/f.txt") == "etag-1"


def test_latest_fingerprint_stops_at_a_newer_read_without_a_token():
    # One line read the path twice and the backend vouched only for the
    # first: the bytes stored are the second read's, so the first read's
    # token would label bytes it never described.
    records = [
        _record("read", "/m/f.txt", "token-a", 3),
        _record("read", "/m/f.txt", None, 3),
    ]
    assert cache_io.latest_fingerprint(records, "/m/f.txt") is None
