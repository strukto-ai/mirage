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

import json
from pathlib import Path

import pytest

from mirage.core.gdrive.fingerprint import drive_fingerprint

# integ/fixtures/gdrive/fingerprint.json is the contract: the TypeScript
# suite (packages/core/src/core/gdrive/fingerprint.test.ts) asserts the same
# rows, so a chain changed in one tree without the other fails both. The
# coalescing operator is exactly where the two hosts can drift silently --
# python's `or` and TypeScript's `??` disagree about "" -- and a shared
# table is the only thing that compares them against one answer.
_FIXTURE = (Path(__file__).parents[4] / "integ" / "fixtures" / "gdrive" /
            "fingerprint.json")

_CASES = json.loads(_FIXTURE.read_text())


def test_the_shared_table_is_not_empty():
    # A fixture that failed to resolve reads as zero cases, and a
    # parametrized suite over zero cases passes without asserting anything.
    assert len(_CASES) >= 6


@pytest.mark.parametrize("name", sorted(_CASES))
def test_drive_fingerprint_matches_the_shared_table(name):
    case = _CASES[name]
    assert drive_fingerprint(case["md5"], case["head_revision"],
                             case["modified"]) == case["expected"]


def test_md5_wins_over_a_head_revision_and_a_stamp():
    assert drive_fingerprint("abc", "r3", "2026-01-01T00:00:00Z") == "abc"


def test_the_head_revision_carries_a_binary_file_with_no_md5():
    # Drive withholds md5Checksum for some binary files; the head revision
    # is the second content token, and dropping this step would send them
    # straight to a timestamp while the read still stamped a revision.
    assert drive_fingerprint(None, "r3", "2026-01-01T00:00:00Z") == "r3"


def test_the_stamp_is_the_only_token_a_native_file_has():
    # Drive populates headRevisionId only for files with binary content, so
    # a gdoc/gsheet/gslide reaches step 3 or nothing at all. A two-step
    # chain hands every native file None, which makes `_probe` answer
    # UNKNOWN and evict the whole mount index on every native read.
    assert drive_fingerprint(
        None, None, "2026-01-01T00:00:00Z") == ("2026-01-01T00:00:00Z")


def test_an_empty_string_is_absent_rather_than_a_value():
    # The inputs that actually arrive are "" and not None: IndexEntry
    # .remote_time defaults to "" and stat_from_api reads
    # `item.get("modifiedTime", "")`. Returning "" would escape the
    # `fingerprint is None` guards at reconcile._probe and drift.check_drift,
    # so the entry would be compared rather than treated as unverifiable.
    # This host's `or` chain skips "" for free; the TypeScript twin has to
    # spell `||`, because its `??` would keep "" and the two hosts would
    # then disagree about the same listing.
    assert drive_fingerprint("", "", "") is None


def test_every_candidate_absent_is_none():
    assert drive_fingerprint(None, None, None) is None


def test_a_non_string_candidate_is_skipped():
    # IndexEntry.extra is dict[str, Any] and a Redis-restored index can hold
    # whatever was serialized into it. Without a type check this host would
    # return an int and `==`-compare it against stat's string forever, while
    # the TypeScript twin's `typeof` guard returned null -- the same silent
    # split the empty-string case exists to catch, one host at a time.
    assert drive_fingerprint(12345, "r3", "2026-01-01T00:00:00Z") == "r3"
