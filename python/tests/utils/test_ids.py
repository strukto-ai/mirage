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

import time
import uuid

import pytest

from mirage.utils.clock import ManualClock
from mirage.utils.ids import (
    IdSource,
    SeededIdSource,
    SystemIdSource,
    _splitmix64,
    new_session_id,
    new_workspace_id,
    random_below,
    shuffle,
    uuid7,
)

# Pinned by the TypeScript twin too (utils/ids.test.ts): one seed draws
# one sequence on both hosts.
SEED_42_WORDS = [825760943, 2622800619, 310231447, 2495256757]
SEED_7_IDS = [
    "018bcfe5-6800-70e6-beb7-02bf41b04f69",
    "018bcfe5-6800-70e7-86ef-ef930baa6e99",
    "018bcfe5-6801-70f9-94f4-c83f9b431a91",
]


def test_uuid7_is_canonical_and_version_7():
    value = uuid7()
    parsed = uuid.UUID(value)
    assert value == str(parsed)
    assert value == value.lower()
    assert parsed.version == 7
    assert parsed.variant == uuid.RFC_4122


def test_uuid7_embeds_current_timestamp():
    # No skew allowance: the stamp is a clock reading taken between
    # these two, never a value derived from the previous id.
    before_ms = time.time_ns() // 1_000_000
    parsed = uuid.UUID(uuid7())
    after_ms = time.time_ns() // 1_000_000
    embedded_ms = parsed.int >> 80
    assert before_ms <= embedded_ms <= after_ms


def test_uuid7_timestamp_never_runs_ahead_of_the_clock():
    # Minting faster than one id per millisecond must not borrow from
    # the future: these ids are database keys, and a timestamp ahead of
    # the clock is wrong data that never corrects itself.
    # The clock is read after the mint, never before: a bound taken
    # first is stale by the millisecond that ticks over between the two
    # lines, which fails an id that was honest when it was stamped.
    for _ in range(5000):
        uuid7()
    embedded_ms = uuid.UUID(uuid7()).int >> 80
    after_ms = time.time_ns() // 1_000_000
    assert embedded_ms <= after_ms


def test_uuid7_orders_within_one_millisecond():
    values = [uuid7() for _ in range(200)]
    assert values == sorted(values)


def test_uuid7_orders_across_milliseconds():
    first = uuid7()
    time.sleep(0.002)
    second = uuid7()
    assert first < second


def test_uuid7_unique():
    values = {uuid7() for _ in range(1000)}
    assert len(values) == 1000


def test_id_kinds_share_the_format():
    assert uuid.UUID(new_workspace_id()).version == 7
    assert uuid.UUID(new_session_id()).version == 7


def test_system_source_satisfies_the_protocol():
    ids: IdSource = SystemIdSource()
    assert uuid.UUID(ids.uuid7()).version == 7
    assert 0 <= ids.random_u32() < 2**32


def test_splitmix64_matches_its_published_vector():
    # The reference output for seed 0, so both hosts cannot drift
    # together from the algorithm.
    _, first = _splitmix64(0)
    assert first == 0xE220A8397B1DCDAF


def test_seeded_source_replays_its_words():
    source = SeededIdSource(42)
    assert [source.random_u32() for _ in range(4)] == SEED_42_WORDS


def test_seeded_sources_with_other_seeds_differ():
    first = SeededIdSource(1)
    second = SeededIdSource(2)
    assert [first.random_u32() for _ in range(4)] != [
        second.random_u32() for _ in range(4)
    ]


def test_seeded_uuid7_is_stamped_from_its_clock():
    clock = ManualClock(start=1_700_000_000.0)
    source = SeededIdSource(7, clock)
    minted = [source.uuid7(), source.uuid7()]
    clock.advance(0.001)
    minted.append(source.uuid7())
    assert minted == SEED_7_IDS
    for value in minted:
        parsed = uuid.UUID(value)
        assert parsed.version == 7
        assert parsed.variant == uuid.RFC_4122
    assert uuid.UUID(minted[0]).int >> 80 == 1_700_000_000_000


def test_seeded_uuid7_without_a_clock_depends_on_the_seed_alone():
    assert SeededIdSource(9).uuid7() == SeededIdSource(9).uuid7()
    assert uuid.UUID(SeededIdSource(9).uuid7()).int >> 80 == 0


def test_seeded_uuid7_borrows_a_millisecond_when_the_counter_runs_out():
    # A frozen clock never ticks, so a burst past the counter has to
    # move on by itself; waiting would hang a seeded run forever.
    source = SeededIdSource(3, ManualClock(start=5.0))
    values = [source.uuid7() for _ in range(5000)]
    assert values == sorted(values)
    assert len(set(values)) == len(values)
    assert uuid.UUID(values[-1]).int >> 80 > 5000


@pytest.mark.parametrize("seed", [-1, 2**53])
def test_seeded_source_refuses_a_seed_out_of_range(seed):
    with pytest.raises(ValueError):
        SeededIdSource(seed)


def test_random_below_replays_across_word_widths():
    source = SeededIdSource(1)
    assert random_below(source, 10) == 0
    assert random_below(source, 2**64 - 1) == 7093093102422396071
    assert random_below(source, 2**32) == 711577048


def test_random_below_stays_in_bounds():
    source = SeededIdSource(11)
    for limit in (1, 2, 3, 62, 2**32 - 1, 2**32, 2**40 + 3):
        for _ in range(50):
            assert 0 <= random_below(source, limit) < limit


@pytest.mark.parametrize("limit", [0, -3])
def test_random_below_refuses_an_empty_range(limit):
    with pytest.raises(ValueError):
        random_below(SeededIdSource(0), limit)


def test_shuffle_replays_a_permutation():
    items = list(range(10))
    shuffle(SeededIdSource(3), items)
    assert items == [6, 2, 3, 8, 9, 0, 1, 5, 7, 4]
