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

from mirage.observe.context import (RecordingScope, finish_record,
                                    push_mount_prefix, push_revisions, record,
                                    record_stream, reset_revisions,
                                    revision_for, start_op, with_mount_prefix,
                                    with_revisions)
from mirage.utils.clock import ManualClock, SystemClock


class ClosingIterator:

    def __init__(self) -> None:
        self.yielded = False
        self.closed = False

    def __aiter__(self) -> "ClosingIterator":
        return self

    async def __anext__(self) -> bytes:
        if self.yielded:
            raise StopAsyncIteration
        self.yielded = True
        return b"chunk"

    async def aclose(self) -> None:
        self.closed = True


def test_record_no_context():
    record("read", "/a.txt", "s3", 100, start_op())


def test_recording_scope_collects_records():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    scope.close()
    assert len(records) == 1
    assert records[0].op == "read"
    assert records[0].bytes == 100


def test_record_after_stop_is_noop():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    scope.close()
    record("read", "/b.txt", "s3", 200, start_op())
    assert len(records) == 1


def test_multiple_records():
    scope = RecordingScope()
    records = scope.records
    record("read", "/a.txt", "s3", 100, start_op())
    record("write", "/b.txt", "ram", 50, start_op())
    scope.close()
    assert len(records) == 2
    assert records[0].source == "s3"
    assert records[1].source == "ram"


def test_record_with_virtual_prefix():
    scope = RecordingScope()
    records = scope.records
    push_mount_prefix("/s3")
    record("read", "/data/file.json", "s3", 100, start_op())
    push_mount_prefix("")
    scope.close()
    assert records[0].path == "/s3/data/file.json"


def test_record_without_prefix():
    scope = RecordingScope()
    records = scope.records
    record("read", "/data/file.json", "s3", 100, start_op())
    scope.close()
    assert records[0].path == "/data/file.json"


def test_record_prefix_already_applied():
    scope = RecordingScope()
    records = scope.records
    push_mount_prefix("/s3")
    record("read", "/s3/data/file.json", "s3", 100, start_op())
    push_mount_prefix("")
    scope.close()
    assert records[0].path == "/s3/data/file.json"


def test_record_prefixes_name_sharing_prefix_leading_text():
    # A bare startswith test would read this as already-prefixed and record
    # "/s3-report.txt", dropping the mount.
    scope = RecordingScope()
    records = scope.records
    push_mount_prefix("/s3")
    record("read", "/s3-report.txt", "s3", 1, start_op())
    push_mount_prefix("")
    scope.close()
    assert records[0].path == "/s3/s3-report.txt"


def test_push_mount_prefix_returns_previous():
    scope = RecordingScope()
    assert push_mount_prefix("/s3") == ""
    assert push_mount_prefix("/r2") == "/s3"
    push_mount_prefix("")
    scope.close()


def test_push_mount_prefix_no_recorder_is_noop():
    assert push_mount_prefix("/s3") == ""


@pytest.mark.asyncio
async def test_with_mount_prefix_close_propagates_to_source():
    source = ClosingIterator()
    wrapped = with_mount_prefix("/s3", source)
    assert await anext(wrapped) == b"chunk"
    await wrapped.aclose()
    assert source.closed


@pytest.mark.asyncio
async def test_with_revisions_close_propagates_to_source():
    source = ClosingIterator()
    wrapped = with_revisions({"/s3/a": "v1"}, source)
    assert await anext(wrapped) == b"chunk"
    await wrapped.aclose()
    assert source.closed


def test_record_carries_fingerprint_when_passed():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op(), fingerprint="abc")
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision is None


def test_record_carries_revision_when_passed():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op(), revision="v1")
    scope.close()
    assert records[0].revision == "v1"
    assert records[0].fingerprint is None


def test_record_carries_both_when_passed():
    scope = RecordingScope()
    records = scope.records
    record("read",
           "/s3/x",
           "s3",
           10,
           start_op(),
           fingerprint="abc",
           revision="v1")
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision == "v1"


def test_record_fingerprint_default_is_none():
    scope = RecordingScope()
    records = scope.records
    record("read", "/s3/x", "s3", 10, start_op())
    scope.close()
    assert records[0].fingerprint is None
    assert records[0].revision is None


def test_record_stream_carries_fingerprint_when_passed():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3", fingerprint="abc")
    scope.close()
    assert rec is not None
    assert records[0].fingerprint == "abc"


def test_record_stream_carries_revision_when_passed():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3", revision="v1")
    scope.close()
    assert rec is not None
    assert records[0].revision == "v1"


def test_record_stream_assignable_after_open():
    scope = RecordingScope()
    records = scope.records
    rec = record_stream("read", "/s3/x", "s3")
    assert rec.fingerprint is None
    assert rec.revision is None
    rec.fingerprint = "abc"
    rec.revision = "v2"
    scope.close()
    assert records[0].fingerprint == "abc"
    assert records[0].revision == "v2"


def test_revision_for_no_context():
    assert revision_for("/s3/a") is None


def test_revision_for_with_context():
    token = push_revisions({"/s3/a": "v1", "/s3/b": "v2"})
    try:
        assert revision_for("/s3/a") == "v1"
        assert revision_for("/s3/b") == "v2"
        assert revision_for("/s3/c") is None
    finally:
        reset_revisions(token)
    assert revision_for("/s3/a") is None


def test_revision_for_with_none_context():
    token = push_revisions(None)
    try:
        assert revision_for("/s3/a") is None
    finally:
        reset_revisions(token)


def test_nested_scope_close_restores_outer():
    outer = RecordingScope()
    record("read", "/a", "s3", 1, start_op())
    inner = RecordingScope()
    record("read", "/b", "s3", 1, start_op())
    inner.close()
    record("read", "/c", "s3", 1, start_op())
    outer.close()
    assert [r.path for r in outer.records] == ["/a", "/c"]
    assert [r.path for r in inner.records] == ["/b"]


def test_inactive_scope_joins_enclosing():
    outer = RecordingScope()
    joined = RecordingScope(active=False)
    record("read", "/a", "s3", 1, start_op())
    joined.close()
    outer.close()
    assert [r.path for r in outer.records] == ["/a"]
    assert joined.records == []


def test_op_timer_reads_the_injected_clock():
    clock = ManualClock()
    timer = start_op(clock)
    assert timer.elapsed_ms == 0
    clock.advance(2.5)
    assert timer.elapsed_ms == 2500


def test_op_timer_defaults_to_the_system_clock():
    assert isinstance(start_op().clock, SystemClock)


def test_finished_record_stamps_from_the_timer_clock():
    clock = ManualClock(start=1700.0)
    timer = start_op(clock)
    clock.advance(3)
    rec = finish_record("read", "/a", "s3", 4, timer)
    assert rec.duration_ms == 3000
    assert rec.timestamp == 1_703_000


def test_recorded_op_carries_the_injected_duration():
    clock = ManualClock(start=0.0)
    scope = RecordingScope()
    timer = start_op(clock)
    clock.advance(1.25)
    record("read", "/a", "s3", 1, timer)
    scope.close()
    assert [r.duration_ms for r in scope.records] == [1250]
