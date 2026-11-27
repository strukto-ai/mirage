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

from mirage.mount.changes import RecentChanges
from mirage.utils.clock import ManualClock
from mirage.workspace.dispatcher.read_batch import HeldFile, ReadBatch


def _batch(changes: RecentChanges) -> ReadBatch:
    return ReadBatch(
        holds=True,
        held={
            "/r/a": HeldFile("/r/a", b"a\n"),
            "/r/link": HeldFile("/r/real", b"r\n"),
        },
        changes=changes,
        count=changes.count,
    )


def test_a_held_file_is_handed_out_once():
    batch = _batch(RecentChanges(ManualClock(), 1))
    assert batch.take("/r/a") == b"a\n"
    assert batch.take("/r/a") is None
    assert batch.take("/r/other") is None
    assert batch.holds


def test_a_change_since_the_reads_drops_what_it_reached():
    # A change to the name the read reached through a link drops it too;
    # one elsewhere drops nothing.
    changes = RecentChanges(ManualClock(), 1)
    batch = _batch(changes)
    changes.note("/r/real")
    changes.note("/r/b")
    assert batch.take("/r/link") is None
    assert batch.take("/r/a") == b"a\n"


def test_a_batch_that_holds_nothing_hands_out_nothing():
    batch = ReadBatch(kept=True)
    assert (batch.holds, batch.take("/r/a")) == (False, None)
