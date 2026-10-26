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

import ast
import functools
import importlib.util
import re
import time
import uuid
from pathlib import Path

import pytest

import mirage
from mirage.utils.clock import ManualClock, SystemClock
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

MIRAGE_DIR = Path(mirage.__file__).parent

# The packages whose ids and draws come from the workspace IdSource.
SEAMED_PACKAGES = (
    "cache",
    "commands",
    "core",
    "execution",
    "process",
    "workspace",
)

DIRECT_DRAWS = frozenset(
    {
        "uuid.uuid1",
        "uuid.uuid4",
        "uuid.uuid6",
        "uuid.uuid7",
        "uuid.uuid8",
        "os.urandom",
        "os.getrandom",
        "tempfile.mkstemp",
        "tempfile.mkdtemp",
        "tempfile.mktemp",
        "tempfile.TemporaryFile",
        "tempfile.NamedTemporaryFile",
        "tempfile.SpooledTemporaryFile",
        "tempfile.TemporaryDirectory",
        "mirage.uuid7",
        "mirage.new_session_id",
        "mirage.new_workspace_id",
        "mirage.utils.ids.uuid7",
        "mirage.utils.ids.new_session_id",
        "mirage.utils.ids.new_workspace_id",
    }
)

DRAWING_MODULES = frozenset({"random", "secrets"})

NON_DRAWING_MEMBERS = frozenset({"secrets.compare_digest"})

# Every draw names one of these in its import, so a module that names
# none of them is not parsed.
DRAW_HINT = re.compile(
    r"uuid|random|secrets|tempfile|new_session_id|new_workspace_id"
)

KEPT_ON_PROCESS_RANDOMNESS = {
    ("core/jq/eval.py", "uuid.uuid4"): (
        "the prelude's key token is drawn once per process and never "
        "reaches output; it only has to be one no program can spell"
    ),
    ("core/ssh/write.py", "uuid.uuid4"): (
        "the atomic upload's temp name lives on the remote host, so a "
        "seeded name would collide with an earlier run's leftover"
    ),
    ("core/disk/write.py", "tempfile.mkstemp"): (
        "the atomic write stages beside its target on the host disk, so a "
        "seeded name would collide with an earlier run's leftover"
    ),
    ("workspace/fuse.py", "uuid.uuid4"): (
        "the FSKit mountpoint is a host directory under /Volumes, shared "
        "with every other process, not a name inside the workspace"
    ),
    ("workspace/fuse.py", "tempfile.mkdtemp"): (
        "the default FUSE mountpoint is a host directory, not a name "
        "inside the workspace"
    ),
    ("workspace/nfs.py", "tempfile.mkdtemp"): (
        "the default NFS mountpoint is a host directory, not a name "
        "inside the workspace"
    ),
    ("workspace/snapshot/state.py", "tempfile.mkdtemp"): (
        "a restored disk mount with no override gets a fresh host root, "
        "which must not collide with another restore's"
    ),
    ("workspace/workspace/workspace.py", "tempfile.mkdtemp"): (
        "a restore stages disk mount files in a host directory it removes "
        "once the mounts have copied them in"
    ),
}


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


class SettableClock:
    def __init__(self, wall: float) -> None:
        self.wall = wall

    def now(self) -> float:
        return self.wall

    def monotonic(self) -> float:
        return 0.0

    async def sleep(self, seconds: float) -> None:
        return None


def test_system_uuid7_is_stamped_from_its_clock():
    source = SystemIdSource(ManualClock(start=1_700_000_000.0))
    assert uuid.UUID(source.uuid7()).int >> 80 == 1_700_000_000_000


def test_system_uuid7_never_waits_on_a_frozen_clock():
    # Waiting for a frozen clock to tick would spin forever, so a burst
    # past the counter moves on to the next millisecond by itself.
    source = SystemIdSource(ManualClock(start=5.0))
    values = [source.uuid7() for _ in range(5000)]
    assert values == sorted(values)
    assert len(set(values)) == len(values)
    assert uuid.UUID(values[0]).int >> 80 == 5000
    assert uuid.UUID(values[-1]).int >> 80 > 5000


def test_system_uuid7_keeps_its_order_when_the_clock_goes_back():
    clock = SettableClock(10.0)
    source = SystemIdSource(clock)
    first = source.uuid7()
    clock.wall = 9.0
    second = source.uuid7()
    assert first < second
    assert uuid.UUID(second).int >> 80 == 10_000


def test_system_clock_sources_share_the_process_floor():
    # Callers build a throwaway source per id; ids from all of them,
    # and from uuid7() itself, still sort by when they were minted.
    values = []
    for _ in range(1000):
        values.append(SystemIdSource().uuid7())
        values.append(uuid7())
        values.append(SystemIdSource(SystemClock()).uuid7())
    assert values == sorted(values)


def test_a_source_on_another_clock_keeps_its_own_floor():
    # A source on a clock far ahead must not drag the process's own
    # ids, or another source's, into its future.
    SystemIdSource(ManualClock(start=4_000_000_000.0)).uuid7()
    embedded_ms = uuid.UUID(uuid7()).int >> 80
    assert embedded_ms <= time.time_ns() // 1_000_000
    early = SystemIdSource(ManualClock(start=5.0))
    assert uuid.UUID(early.uuid7()).int >> 80 == 5000


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


def _bindings(tree: ast.Module, package: str) -> dict[str, str]:
    """Each name an import binds, mapped to the dotted name it stands for.

    Args:
        tree (ast.Module): a parsed module.
        package (str): the module's package, which relative imports
            resolve against.
    """
    bound: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".")[0]
                bound[alias.asname or top] = (
                    alias.name if alias.asname else top
                )
        elif isinstance(node, ast.ImportFrom):
            module = importlib.util.resolve_name(
                "." * node.level + (node.module or ""), package
            )
            for alias in node.names:
                bound[alias.asname or alias.name] = f"{module}.{alias.name}"
    return bound


def _dotted(node: ast.expr, bound: dict[str, str]) -> str | None:
    """The dotted name ``node`` refers to through the imports, if any.

    Args:
        node (ast.expr): a name, attribute or call.
        bound (dict[str, str]): the module's import bindings.
    """
    if isinstance(node, ast.Name):
        return bound.get(node.id)
    if isinstance(node, ast.Attribute):
        base = _dotted(node.value, bound)
        return None if base is None else f"{base}.{node.attr}"
    if isinstance(node, ast.Call):
        func = _dotted(node.func, bound)
        return None if func is None else f"{func}()"
    return None


def _draw(name: str) -> str | None:
    """The direct draw ``name`` makes, if it makes one.

    Anything the ``random`` or ``secrets`` module holds counts, except
    a member that draws nothing, and is reported by the module member
    it goes through.

    Args:
        name (str): a dotted name an import resolves to.
    """
    if name in DIRECT_DRAWS:
        return name
    module, _, rest = name.partition(".")
    if module not in DRAWING_MODULES or not rest:
        return None
    member = f"{module}.{rest.split('.')[0].removesuffix('()')}"
    return None if member in NON_DRAWING_MEMBERS else member


def direct_draws(source: str, package: str) -> set[str]:
    """Every draw ``source`` makes past the IdSource.

    Args:
        source (str): a module's Python source.
        package (str): the module's package, which relative imports
            resolve against.
    """
    if not DRAW_HINT.search(source):
        return set()
    tree = ast.parse(source)
    bound = _bindings(tree, package)
    named = set(bound.values()) | {
        name
        for node in ast.walk(tree)
        if isinstance(node, (ast.Name, ast.Attribute))
        and (name := _dotted(node, bound))
    }
    return {draw for name in named if (draw := _draw(name))}


@functools.cache
def _seamed_draws() -> frozenset[tuple[str, str]]:
    return frozenset(
        (path.relative_to(MIRAGE_DIR).as_posix(), draw)
        for package in SEAMED_PACKAGES
        for path in (MIRAGE_DIR / package).rglob("*.py")
        for draw in direct_draws(
            path.read_text(),
            ".".join(
                (mirage.__name__, *path.relative_to(MIRAGE_DIR).parent.parts)
            ),
        )
    )


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("import uuid\nuuid.uuid4()", {"uuid.uuid4"}),
        ("import uuid as u\nu.uuid1().hex", {"uuid.uuid1"}),
        ("from uuid import uuid4", {"uuid.uuid4"}),
        ("from uuid import uuid4 as fresh\nfresh()", {"uuid.uuid4"}),
        ("import uuid\nfield(default_factory=uuid.uuid4)", {"uuid.uuid4"}),
        ("import random\nrandom.random()", {"random.random"}),
        ("import random as r\nr.getrandbits(32)", {"random.getrandbits"}),
        ("from random import shuffle", {"random.shuffle"}),
        ("import random\nrandom.Random().choice(xs)", {"random.Random"}),
        ("import random\nrandom.Random(7)", {"random.Random"}),
        ("from random import SystemRandom as S\nS()", {"random.SystemRandom"}),
        ("import secrets\nsecrets.token_hex(6)", {"secrets.token_hex"}),
        ("from secrets import randbits", {"secrets.randbits"}),
        ("import os\nos.urandom(16)", {"os.urandom"}),
        ("from os import urandom as u\nu(4)", {"os.urandom"}),
        ("import tempfile\ntempfile.mkdtemp()", {"tempfile.mkdtemp"}),
        (
            "from tempfile import NamedTemporaryFile as T",
            {"tempfile.NamedTemporaryFile"},
        ),
        (
            "from mirage.utils.ids import uuid7\nuuid7()",
            {"mirage.utils.ids.uuid7"},
        ),
        (
            "from mirage.utils.ids import new_session_id as mint\nmint()",
            {"mirage.utils.ids.new_session_id"},
        ),
        (
            "from ...utils.ids import uuid7\nuuid7()",
            {"mirage.utils.ids.uuid7"},
        ),
        (
            "from ...utils import ids\nids.new_workspace_id()",
            {"mirage.utils.ids.new_workspace_id"},
        ),
        ("import mirage\nmirage.uuid7()", {"mirage.uuid7"}),
        ("from mirage import uuid7", {"mirage.uuid7"}),
    ],
)
def test_the_detector_catches_a_planted_draw(source, expected):
    assert direct_draws(source, "mirage.core.jq") == expected


@pytest.mark.parametrize(
    "allowed",
    [
        "self._ids.uuid7()",
        "ctx.ids.random_u32()",
        "from mirage.utils.ids import IdSource, SystemIdSource",
        "from mirage.utils.ids import random_below, shuffle\n"
        "shuffle(ids, items)",
        "from ...utils.ids import random_below\nrandom_below(ids, 10)",
        "import uuid\nuuid.UUID(text)",
        "import uuid\nuuid.uuid5(uuid.NAMESPACE_URL, name)",
        "import random",
        "from secrets import compare_digest\ncompare_digest(a, b)",
        "import tempfile\ntempfile.gettempdir()",
        "import os\nos.environ.get('HOME')",
        "from mirage.secrets.config import EnvVar",
        "from ...secrets.registry import fetch_secret",
        "from mirage.vfs.secrets import reveal_secret",
        "uuid7()",
        "random.random()",
    ],
)
def test_the_detector_leaves_what_draws_from_the_id_source(allowed):
    assert direct_draws(allowed, "mirage.core.jq") == set()


def test_no_seamed_module_draws_past_the_id_source():
    assert _seamed_draws() - set(KEPT_ON_PROCESS_RANDOMNESS) == set()


def test_every_kept_process_draw_is_still_made():
    assert set(KEPT_ON_PROCESS_RANDOMNESS) - _seamed_draws() == set()
