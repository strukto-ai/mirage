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

import tracemalloc
from dataclasses import dataclass, field

from mirage.commands.cli.builtin.git.graph import CommitGraph

# Every expected graph below is what git 2.47.3 prints for the same
# history, built with fast-import and walked with --all.


@dataclass
class _Commit:
    id: bytes
    parents: list[bytes] = field(default_factory=list)


def _walk(spec: str) -> list[_Commit]:
    """Commits in walk order from ``name: parents`` lines.

    Args:
        spec (str): one commit per line, in the order git walks them.
    """
    commits = []
    for line in spec.strip().splitlines():
        name, _, parents = line.partition(":")
        commits.append(
            _Commit(
                name.strip().encode(), [p.encode() for p in parents.split()]
            )
        )
    return commits


def _log(
    walked: list[_Commit],
    shown: str | None = None,
    lines: int = 1,
    separated: bool = False,
    first_parent: bool = False,
) -> list[str]:
    """What a log prints with the graph, each commit's text its name.

    Args:
        walked (list[_Commit]): the walked commits, in order.
        shown (str | None): the names of the printed ones; all if None.
        lines (int): the lines of text per commit.
        separated (bool): a separator line between commits, as
            ``--format=format:%s%n`` prints.
        first_parent (bool): ``--first-parent``.
    """
    ids = {commit.id for commit in walked}
    printed = set(shown.encode().split()) if shown is not None else ids
    graph = CommitGraph(ids.__contains__, first_parent)
    out = ""
    for commit in walked:
        graph.walk(commit)
        if commit.id not in printed:
            continue
        if out and separated:
            out += graph.filler() + "\n"
        name = commit.id.decode()
        out += graph.lead_in() + graph.around(f"{name}\n" * lines)
    return out.split("\n")[:-1]


def test_draws_a_merge_and_collapses_its_branch_line():
    walked = _walk("M: C B\nB: A\nC: A\nA:")
    assert _log(walked) == [
        "*   M",
        "|\\  ",
        "| * B",
        "* | C",
        "|/  ",
        "* A",
    ]


def test_spreads_the_lines_right_of_an_octopus_before_its_row():
    walked = _walk(
        "K: P M S\nS: B\nM: Q0 Q1 Q2\nQ2: B\nQ1: B\nQ0: B\nP: B\nB:"
    )
    assert _log(walked) == [
        "*-.   K",
        "|\\ \\  ",
        "| | * S",
        "| | |     ",
        "| |  \\    ",
        "| *-. \\   M",
        "| |\\ \\ \\  ",
        "| | | * | Q2",
        "| | | |/  ",
        "| | * / Q1",
        "| | |/  ",
        "| * / Q0",
        "| |/  ",
        "* / P",
        "|/  ",
        "* B",
    ]


def test_sends_a_first_parent_waiting_to_the_left_straight_to_it():
    walked = _walk(
        "K: P M S\nS: B\nM: P Q1 Q2 Q3\nQ3: B\nQ2: B\nQ1: B\nP: B\nB:"
    )
    assert _log(walked)[5:7] == ["| *-. \\   M", "|/|\\ \\ \\  "]


def test_glides_under_standing_columns():
    walked = _walk(
        "K: P M\nM: P Q1 Q2\nQ2: B\nQ1: B\nP: B\nJ: S\nI: S R1 R2\n"
        "R2: B\nR1: B\nS: B\nB:"
    )
    assert _log(walked)[9:18] == [
        "| * J",
        "| | *   I",
        "| |/|\\  ",
        "| | | * R2",
        "| |_|/  ",
        "|/| |   ",
        "| | * R1",
        "| |/  ",
        "|/|   ",
    ]


def test_follows_first_parents_only():
    walked = _walk("K: P M S\nP: B\nB:")
    assert _log(walked, first_parent=True) == ["* K", "* P", "* B"]


def test_separator_stands_lines_right_of_a_lead_and_two_parents_a_cell_over():
    walked = _walk("K: P M S\nS: B\nM: P Q1 Q2\nQ2: B\nQ1: B\nP: B\nB:")
    assert _log(walked, lines=2, separated=True)[3:8] == [
        "| | * S",
        "| | | S",
        "| |  |  ",
        "| * |   M",
        "|/|\\ \\  M",
    ]


def test_separator_widens_for_the_line_it_stands_over():
    walked = _walk("K: P M S\nM: P Q1 S\nS: B\nQ1: B\nP: B\nB:")
    assert _log(walked, lines=2, separated=True)[:5] == [
        "*-.   K",
        "|\\ \\  K",
        "| |  | ",
        "| * | M",
        "|/|\\| M",
    ]


def test_separator_is_the_first_row_of_an_octopus_spreading_lines():
    walked = _walk(
        "K: P M S\nS: B\nM: P Q1 Q2 Q3\nQ3: B\nQ2: B\nQ1: B\nP: B\nB:"
    )
    assert _log(walked, lines=2, separated=True)[3:9] == [
        "| | * S",
        "| | | S",
        "| | |     ",
        "| |  \\    ",
        "| *-. \\   M",
        "|/|\\ \\ \\  M",
    ]


def test_marks_skipped_commits():
    walked = _walk("T: Z\nO: A B C\nC: Z\nB: Z\nA: Z\nZ:")
    assert _log(walked, shown="T B Z") == [
        "* T",
        "...   ",
        "| | * B",
        "| |/  ",
        "|/|   ",
        "...",
        "* Z",
    ]


def test_skip_row_stands_for_the_separator():
    walked = _walk("T: Z\nO: A B C\nC: Z\nB: Z\nA: Z\nZ:")
    assert _log(walked, shown="T B Z", lines=2, separated=True) == [
        "* T",
        "| T",
        "...   ",
        "| | * B",
        "| |/  B",
        "|/|   ",
        "...",
        "* Z",
        "  Z",
    ]


def test_pads_a_further_header_of_a_drawn_commit():
    walked = _walk("M: C B\nB: A\nC: A\nA:")
    ids = {commit.id for commit in walked}
    graph = CommitGraph(ids.__contains__, False)
    graph.walk(walked[0])
    out = graph.lead_in() + graph.around("M\n")
    out += graph.filler() + "\n" + graph.filler() + "A\tM.txt\n"
    out += graph.lead_in() + graph.around("M\n")
    assert out.split("\n")[:-1] == [
        "*   M",
        "|\\  ",
        "| | ",
        "| | A\tM.txt",
        "| | M",
    ]


def test_widens_rows_for_an_octopus_spreading_past_its_parents():
    walked = _walk("K: A B M C\nM: A B D C\nC:\nD:\nB:\nA:")
    assert _log(walked) == [
        "*---.   K",
        "|\\ \\ \\  ",
        "| | | \\   ",
        "| | |  \\  ",
        "| | *-. | M",
        "| |/|\\ \\| ",
        "|/| | |/  ",
        "| | | * C",
        "| | * D",
        "| * B",
        "* A",
    ]


def test_follows_only_a_first_parent_that_is_walked():
    # git log --graph --first-parent --format=%s%n%s M B ^A
    walked = _walk("M: A B\nB: Y\nY: Z")
    assert _log(walked, lines=2, first_parent=True) == [
        "* M",
        "  M",
        "* B",
        "| B",
        "* Y",
        "  Y",
    ]


def test_leans_lines_right_of_a_merge_row_into_an_octopus():
    walked = _walk(
        "c0: c7\nc1: c2 c8\nc2: c7 c3\nc3: c5 c4 c7\nc7: c8\nc8:\nc4:\nc5:"
    )
    assert _log(walked) == [
        "* c0",
        "| *   c1",
        "| |\\  ",
        "| * | c2",
        "|/| | ",
        "| | \\     ",
        "| |  \\    ",
        "| *-. \\   c3",
        "| |\\ \\ \\  ",
        "| |_|/ /  ",
        "|/| | |   ",
        "* | | | c7",
        "| |_|/  ",
        "|/| |   ",
        "* | | c8",
        " / /  ",
        "| * c4",
        "* c5",
    ]


def test_slides_under_a_standing_column_on_the_row_it_lands():
    walked = _walk("c2: c9\nc3: c6 c7 c8\nc5: c9 c7 c8 c6\nc6:\nc8:\nc7:\nc9:")
    assert _log(walked) == [
        "* c2",
        "| *-.   c3",
        "| |\\ \\  ",
        "| | | | *-.   c5",
        "| |_|_|/|\\ \\  ",
        "|/| | |/ / /  ",
        "| | |/| / /   ",
        "| | | |/ /    ",
        "| | |_| /     ",
        "| |/| |       ",
        "| * | | c6",
        "|  / /  ",
        "| | * c8",
        "| * c7",
        "* c9",
    ]


def test_keeps_a_reach_left_short_by_a_beside_parent_as_a_line():
    walked = _walk(
        "c0: c1 c7\nc1: c6 c3 c2\nc2: c6 c3 c9 c7\nc7:\nc9:\nc3:\nc6:"
    )
    assert _log(walked) == [
        "*   c0",
        "|\\  ",
        "| \\     ",
        "|  \\    ",
        "*-. \\   c1",
        "|\\ \\ \\  ",
        "| | | \\   ",
        "| | |  \\  ",
        "| | *-. | c2",
        "| |/|\\ \\| ",
        "|/| | |/  ",
        "| | | * c7",
        "| | * c9",
        "| * c3",
        "* c6",
    ]


def test_moves_lines_that_start_a_row_together_as_one():
    walked = _walk(
        "c0: c5 c9\nc1: c4 c8\nc4: c7 c8 c5\nc5: c8 c9 c7\nc7:\nc9:\nc8:"
    )
    assert _log(walked)[8:20] == [
        "| |_|_|/ /  ",
        "|/| | | /   ",
        "| | | |/    ",
        "| | | |     ",
        "|  \\ \\ \\    ",
        "*-. \\ \\ \\   c5",
        "|\\ \\ \\ \\ \\  ",
        "| | |/ / /  ",
        "| |/| / /   ",
        "| | |/ /    ",
        "| |_| /     ",
        "|/| |       ",
    ]


def test_widens_the_separator_by_an_octopus_dashes():
    walked = _walk("c0: c3 c5 c1\nc1: c3 c5 c2 c4\nc4:\nc2:\nc5:\nc3:")
    assert _log(walked, lines=2, separated=True)[:5] == [
        "*-.   c0",
        "|\\ \\  c0",
        "| | |    ",
        "| | *-. c1",
        "| |/|\\ \\c1",
    ]


def test_a_skipped_commit_holds_one_row_at_a_time():
    # The octopus O is walked but not printed: its 800 spread rows of
    # about 800 cells come to some 770 kB when kept, a tenth of that
    # one at a time.
    parents = [b"P%d" % i for i in range(400)]
    walked = [
        _Commit(b"K", [b"O", b"S"]),
        _Commit(b"O", parents),
        _Commit(b"S", [b"Z"]),
    ]
    walked += [_Commit(p, [b"Z"]) for p in parents] + [_Commit(b"Z")]
    ids = {commit.id for commit in walked}
    graph = CommitGraph(ids.__contains__, False)
    graph.walk(walked[0])
    graph.lead_in()
    graph.around("K\n")
    graph.walk(walked[1])
    tracemalloc.start()
    try:
        graph.walk(walked[2])
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 250_000


def test_a_skip_row_is_as_wide_as_the_merge_it_stands_before():
    # `git log --graph -S` passing by the commit above a merge pads the
    # `...` row to the merge's own row (git 2.47.3).
    walked = _walk("X: M\nM: A B\nB: A\nA:")
    assert _log(walked, shown="M B A")[0] == "... "


def test_draws_a_boundary_commit_with_an_o():
    walked = _walk("M: A B\nB: A\nA:")
    ids = {commit.id for commit in walked}
    graph = CommitGraph(ids.__contains__, False, frozenset({b"A"}))
    out = ""
    for commit in walked:
        graph.walk(commit)
        out += graph.lead_in() + graph.around(f"{commit.id.decode()}\n")
    assert out.split("\n")[:-1] == ["*   M", "|\\  ", "| * B", "|/  ", "o A"]


def test_draws_the_parents_a_path_limited_walk_hands_over():
    walked = _walk("X: Y\nA:")
    ids = {commit.id for commit in walked}
    graph = CommitGraph(ids.__contains__, False, parents={b"X": (b"A",)})
    out = ""
    for commit in walked:
        graph.walk(commit)
        out += graph.lead_in() + graph.around(f"{commit.id.decode()}\n")
    assert out.split("\n")[:-1] == ["* X", "* A"]
