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

from mirage.policy import HandOff, Occurrence
from mirage.runtime.routing import command_nodes
from mirage.shell import parse
from mirage.shell.types import NodeType
from mirage.workspace.node.occurrence import (Frame, argv_frame, body_frame,
                                              claimant_for, evaluated_from,
                                              line_frame, occurrence_in,
                                              occurrence_of, part_of,
                                              root_frame, segment_frames,
                                              whole_occurrence)


def _first(node, kind: str):
    """The first node of a type under a tree, depth first.

    Args:
        node: the tree to scan.
        kind (str): the tree-sitter node type.
    """
    stack = [node]
    while stack:
        current = stack.pop()
        if current.type == kind:
            return current
        stack.extend(reversed(current.children))
    raise AssertionError(kind)


def test_a_command_stands_at_its_span_in_the_line():
    line = "touch /tmp/x && cat /data/secret.txt"
    ast = parse(line)
    frame = root_frame(ast, None)
    assert frame == Frame(line, 0, None)
    first, second = command_nodes(ast)
    assert occurrence_in(first, frame) == Occurrence(None, line, 0, 12)
    assert occurrence_in(second, frame) == Occurrence(None, line, 16, 36)


def test_the_gate_and_the_pass_compute_one_occurrence():
    # The gate builds the frame from the node it runs and the pass from
    # the tree it walks; on one parse they have to agree.
    ast = parse("cat /data/secret.txt")
    node = list(command_nodes(ast))[0]
    handed = HandOff()
    assert occurrence_of(node,
                         handed) == occurrence_in(node, root_frame(ast, None))
    assert claimant_for(node, None) is None
    claimant = claimant_for(node, handed)
    assert claimant is not None
    assert claimant.line is handed
    assert claimant.occurrence == occurrence_of(node, handed)


def test_a_nested_line_stands_under_the_node_that_ran_it():
    # A nested line's hand-off carries the node its text came from, and
    # every command of the nested parse stands under it.
    outer = parse("eval 'cat /data/secret.txt'")
    origin = occurrence_of(list(command_nodes(outer))[0], HandOff())
    inner = parse("cat /data/secret.txt")
    nested = HandOff(origin=origin)
    at = occurrence_of(list(command_nodes(inner))[0], nested)
    assert at == Occurrence(origin, "cat /data/secret.txt", 0, 20)
    # The pass reads the line the word runs in a frame of its own, and
    # places the same command at the same occurrence.
    frame = line_frame("cat /data/secret.txt", origin)
    assert occurrence_in(list(command_nodes(inner))[0], frame) == at


def test_a_substitution_body_is_read_as_the_nested_line_parses_it():
    line = "echo $(cat /data/secret.txt) && ls"
    ast = parse(line)
    frame = root_frame(ast, None)
    sub = _first(ast, NodeType.COMMAND_SUBSTITUTION)
    body = body_frame(sub, frame)
    assert body is not None
    assert body.text == "cat /data/secret.txt"
    assert body.parent == occurrence_in(sub, frame)
    inner = next(
        c for c in command_nodes(ast)
        if c.start_byte > sub.start_byte and c.end_byte <= sub.end_byte)
    walked = occurrence_in(inner, body)
    # What the nested line computes when it parses the body alone.
    nested = HandOff(origin=occurrence_in(sub, frame))
    ran = occurrence_of(list(command_nodes(parse(body.text)))[0], nested)
    assert walked == ran


def test_a_backtick_region_is_one_line_per_pair():
    # tree-sitter lexes touching pairs as one node whose subtree merges
    # the two commands into one; the evaluator splits the region and
    # runs each pair as a line of its own, standing at the pair's own
    # span on the line, and the pass reads it the same way.
    line = "echo `cat /data/secret.txt` `echo ok`"
    ast = parse(line)
    frame = root_frame(ast, None)
    sub = _first(ast, NodeType.COMMAND_SUBSTITUTION)
    assert body_frame(sub, frame) is None
    first, second = segment_frames(sub, frame)
    assert (first.text, second.text) == ("cat /data/secret.txt", "echo ok")
    for inner in (first, second):
        assert inner.base == 0
        assert inner.parent is not None
        assert line[inner.parent.start:inner.parent.end] == inner.text
    # What the nested line computes when expansion hands the executor
    # the pair's span within the node.
    assert occurrence_of(sub, HandOff(), (1, 21)) == first.parent
    assert part_of(occurrence_in(sub, frame), 1, 21) == first.parent


def test_a_folded_prefix_is_set_aside_before_a_region_is_split():
    line = 'echo "$a `cat /data/secret.txt`"'
    ast = parse(line)
    frame = root_frame(ast, None)
    sub = _first(ast, NodeType.COMMAND_SUBSTITUTION)
    inner, = segment_frames(sub, frame)
    assert inner.text == "cat /data/secret.txt"
    assert inner.parent is not None
    assert line[inner.parent.start:inner.parent.end] == inner.text


def test_a_node_that_is_no_substitution_has_no_body_frame():
    ast = parse("(cd /tmp && ls)")
    frame = root_frame(ast, None)
    assert body_frame(_first(ast, NodeType.SUBSHELL), frame) is None


def test_words_a_command_runs_stand_at_the_whole_text():
    parent = Occurrence(None, "xargs cat", 0, 9)
    frame = line_frame("cat", parent)
    assert whole_occurrence(frame) == Occurrence(parent, "cat", 0, 3)


def test_words_a_command_hands_on_are_spelled_as_it_spells_them():
    # command, env, timeout and xargs each hand the evaluator their
    # words joined with shlex, so the nested gate parses the quoted
    # spelling; the pass computes the occurrence on that spelling, and
    # the parse places the command at the whole of it.
    parent = Occurrence(None, "command cat '/data/secret file'", 0, 31)
    frame = argv_frame(["cat", "/data/secret file"], parent)
    assert frame.text == "cat '/data/secret file'"
    node = list(command_nodes(parse(frame.text)))[0]
    assert occurrence_in(node, frame) == whole_occurrence(frame)


def test_words_holding_a_multibyte_character_end_where_the_parse_ends():
    # The nested gate parses the re-spelled line and places the command
    # by the parser's byte offsets; an end counted in code points fell
    # short by one per multibyte character, so the pass's claim was for
    # an occurrence the gate never computed.
    parent = Occurrence(None, "command cat /data/secrét", 0, 25)
    frame = argv_frame(["cat", "/data/secrét"], parent)
    whole = whole_occurrence(frame)
    assert whole.end == len(frame.text.encode()) > len(frame.text)
    node = list(command_nodes(parse(frame.text)))[0]
    assert occurrence_in(node, frame) == whole


def test_a_pair_after_a_multibyte_character_stands_at_its_bytes():
    line = "echo `echo é` `cat /data/secret.txt`"
    ast = parse(line)
    frame = root_frame(ast, None)
    sub = _first(ast, NodeType.COMMAND_SUBSTITUTION)
    first, second = segment_frames(sub, frame)
    assert (first.text, second.text) == ("echo é", "cat /data/secret.txt")
    raw = line.encode()
    for inner in (first, second):
        assert inner.parent is not None
        assert raw[inner.parent.start:inner.parent.end].decode() == inner.text


def test_a_line_read_from_a_node_stands_under_it():
    # One text read from two nodes (an alias invoked twice) is two places
    # on the line: the rewritten line's command is placed under the word
    # that named it, and the line it runs as hands up to the line's own
    # hand-off.
    handed = HandOff()
    first, second = command_nodes(parse("c && c"))
    under_first = evaluated_from(first, handed)
    under_second = evaluated_from(second, handed)
    assert under_first.parent is handed and under_second.parent is handed
    assert under_first.origin == occurrence_of(first, handed)
    assert under_first.origin != under_second.origin
    cat = list(command_nodes(parse("cat /data/secret.txt")))[0]
    assert occurrence_of(cat, under_first).parent == under_first.origin
    assert occurrence_of(cat, under_first) != occurrence_of(cat, under_second)
