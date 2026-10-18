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

import random
import tracemalloc

from mirage.commands.cli.builtin.git.combined import _pairing, combined_lines


def _numbers(count: int, **edits: str) -> list[str]:
    return [edits.get(f"n{i}", str(i)) + "\n" for i in range(1, count + 1)]


def test_result_matching_every_parent_has_no_hunk():
    lines = _numbers(5)
    assert combined_lines([lines, lines], lines, dense=True) == []


def test_conflict_resolution_marks_each_parent_column():
    ours = ["a\n", "MAIN\n", "c\n"]
    theirs = ["a\n", "SIDE\n", "c\n"]
    result = ["a\n", "BOTH\n", "c\n"]
    assert combined_lines([ours, theirs], result, dense=True) == [
        "@@@ -1,3 -1,3 +1,3 @@@\n",
        "  a\n",
        "- MAIN\n",
        " -SIDE\n",
        "++BOTH\n",
        "  c\n",
    ]


def test_dense_drops_a_clean_merge_of_distant_edits():
    ours = _numbers(20, n8="eight")
    theirs = _numbers(20, n2="two")
    result = _numbers(20, n2="two", n8="eight")
    assert combined_lines([ours, theirs], result, dense=True) == []
    assert combined_lines([ours, theirs], result, dense=False)[0] == (
        "@@@ -1,11 -1,11 +1,11 @@@\n"
    )


def test_dense_keeps_edits_from_both_sides_within_context():
    ours = _numbers(20, n5="five")
    theirs = _numbers(20, n2="two")
    result = _numbers(20, n2="two", n5="five")
    assert combined_lines([ours, theirs], result, dense=True) == [
        "@@@ -1,8 -1,8 +1,8 @@@\n",
        "  1\n",
        "- 2\n",
        "+ two\n",
        "  3\n",
        "  4\n",
        " -5\n",
        " +five\n",
        "  6\n",
        "  7\n",
        "  8\n",
    ]


def test_empty_sides_number_from_one():
    assert combined_lines([[], []], ["new\n"], dense=True) == [
        "@@@ -1,0 -1,0 +1,1 @@@\n",
        "++new\n",
    ]
    assert combined_lines([["b\n"], ["b\n"]], [], dense=True) == [
        "@@@ -1,1 -1,1 +1,0 @@@\n",
        "--b\n",
    ]


def test_hunk_header_carries_function_context_less_its_last_byte():
    lines = [f"  body {i}\n" for i in range(1, 21)]
    lines[4] = "function handleRequest(request, response) {\n"
    ours, theirs, result = list(lines), list(lines), list(lines)
    ours[14], theirs[14], result[14] = "  MAIN\n", "  SIDE\n", "  BOTH\n"
    body = combined_lines([ours, theirs], result, dense=True)
    assert body[0] == (
        "@@@ -12,7 -12,7 +12,7 @@@ function handleRequest(request, respons\n"
    )


def test_missing_final_newline_gets_no_marker():
    body = combined_lines(
        [["x\n", "MAIN"], ["x\n", "SIDE"]], ["x\n", "BOTH"], dense=True
    )
    assert body[-3:] == ["- MAIN\n", " -SIDE\n", "++BOTH\n"]


def test_zero_context_deletion_keeps_a_valid_empty_result_range():
    assert combined_lines(
        [["gone\n"], ["gone\n"]], [], dense=True, context=0
    ) == ["@@@ -1,1 -1,1 +1,0 @@@\n", "--gone\n"]


def test_lines_three_parents_dropped_fold_in_parent_order():
    parents = [
        ["k\n", "a\n", "b\n", "k2\n"],
        ["k\n", "b\n", "c\n", "k2\n"],
        ["k\n", "a\n", "c\n", "k2\n"],
    ]
    assert combined_lines(parents, ["k\n", "Z\n", "k2\n"], dense=False) == [
        "@@@@ -1,4 -1,4 -1,4 +1,3 @@@@\n",
        "   k\n",
        "- -a\n",
        "-- b\n",
        " --c\n",
        "+++Z\n",
        "   k2\n",
    ]


def test_equally_long_folds_pair_the_later_line():
    parents = [["k\n", "a\n", "b\n", "k2\n"], ["k\n", "b\n", "a\n", "k2\n"]]
    assert combined_lines(parents, ["k\n", "Z\n", "k2\n"], dense=True) == [
        "@@@ -1,4 -1,4 +1,3 @@@\n",
        "  k\n",
        "- a\n",
        "--b\n",
        " -a\n",
        "++Z\n",
        "  k2\n",
    ]


def test_dropped_lines_pair_across_a_missing_final_newline():
    assert combined_lines(
        [["x\n", "y"], ["x\n", "y\n"]], ["x\n", "z\n"], dense=True
    ) == ["@@@ -1,2 -1,2 +1,2 @@@\n", "  x\n", "--y\n", "++z\n"]


def test_dense_hides_a_clean_drop_inside_a_shown_hunk_but_counts_it():
    ours = _numbers(40, n10="a", n17="b")
    ours.insert(13, "Q\n")
    theirs = _numbers(40, n10="c", n17="d")
    result = _numbers(40, n10="E1", n17="E2", n40="EVIL")
    dense = combined_lines([ours, theirs], result, dense=True)
    loose = combined_lines([ours, theirs], result, dense=False)
    assert dense[0] == loose[0] == "@@@ -7,15 -7,14 +7,14 @@@\n"
    assert "- Q\n" not in dense
    assert "- Q\n" in loose


def test_zero_context_joins_a_dropped_row_to_the_next_change():
    ours = ["1\n", "2\n", "Q\n", "3\n", "a\n", "5\n"]
    theirs = ["1\n", "2\n", "3\n", "b\n", "5\n"]
    result = ["1\n", "2\n", "3\n", "R\n", "5\n"]
    assert combined_lines([ours, theirs], result, dense=True, context=0) == [
        "@@@ -3,2 -3,1 +3,1 @@@\n",
        "- Q\n",
        "- a\n",
        " -b\n",
        "++R\n",
    ]


def test_header_names_a_line_only_from_those_skipped_since_the_last_hunk():
    named = {"n12": "func inside(", "n20": "func between("}
    ours = _numbers(40, n10="a", n30="a2", **named)
    theirs = _numbers(40, n10="b", n30="b2", **named)
    result = _numbers(40, n10="R1", n30="R2", **named)
    body = combined_lines([ours, theirs], result, dense=True)
    assert [line for line in body if line.startswith("@@@")] == [
        "@@@ -7,7 -7,7 +7,7 @@@\n",
        "@@@ -27,7 -27,7 +27,7 @@@ func between\n",
    ]


def _reference_pairing(left, right):
    best = [[0] * (len(right) + 1) for _ in range(len(left) + 1)]
    for i, a in enumerate(left, 1):
        for j, b in enumerate(right, 1):
            best[i][j] = (
                best[i - 1][j - 1] + 1
                if a == b
                else max(best[i - 1][j], best[i][j - 1])
            )
    pairs = []
    i, j = len(left), len(right)
    while i and j:
        if left[i - 1] == right[j - 1]:
            i, j = i - 1, j - 1
            pairs.append((i, j))
        elif best[i][j - 1] >= best[i - 1][j]:
            j -= 1
        else:
            i -= 1
    return pairs[::-1]


def test_pairing_under_a_small_row_budget_keeps_the_same_pairs():
    rng = random.Random(5)
    for _ in range(300):
        letters = rng.choice([2, 3, 6, 40])
        left = [str(rng.randrange(letters)) for _ in range(rng.randrange(40))]
        right = [str(rng.randrange(letters)) for _ in range(rng.randrange(40))]
        want = _reference_pairing(left, right)
        for budget in (1, 7, 64, 400, 1 << 26):
            assert _pairing(left, right, budget) == want


def test_folding_long_drops_keeps_memory_far_below_their_product():
    ours = [f"line {i}\n" for i in range(20000)]
    theirs = [
        f"edit {i}\n" if i % 10 == 0 else line for i, line in enumerate(ours)
    ]
    tracemalloc.start()
    try:
        body = combined_lines([ours, theirs], [], dense=True)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert body[0] == "@@@ -1,20000 -1,20000 +1,0 @@@\n"
    assert len(body) == 1 + 20000 + 2000
    # Keeping a row per line of one drop over the other would take
    # 20,001 rows of 20,000 bits: 50 MB before any mask.
    assert peak < 32 * 1024 * 1024
