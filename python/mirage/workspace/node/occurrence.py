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

import shlex
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from mirage.policy import Claimant, HandOff, Occurrence
from mirage.shell.backticks import split_backtick_region
from mirage.shell.helpers import byte_offset, get_function_name, get_text
from mirage.workspace.session import SessionState

# What opens and closes a substitution's body, in the order the
# openers are tried; the body between them is the text a nested line
# is parsed from. A backtick region is not here: tree-sitter lexes
# touching pairs as one node, so it is split into lines
# (``segment_frames``) rather than framed as one body.
SUBSTITUTION_DELIMITERS = (("$(", ")"), ("<(", ")"), (">(", ")"))


@dataclass(frozen=True, slots=True)
class Frame:
    """The text a walk reads commands from, as the line that evaluates
    it will parse it.

    The pass walks one tree and computes for every command the
    occurrence the gate will compute when it runs, and the gate may be
    running a different parse of the same text: a substitution's body
    is parsed on its own by the nested line, at offsets that start from
    zero, while the pass reads it as a subtree of the outer line. The
    frame is what makes the two agree: ``text`` is what the nested line
    parses, ``base`` is where that text starts in the tree being
    walked, and ``parent`` is the occurrence its commands stand under.

    Args:
        text (str): the text a parse of this scope reads.
        base (int): the byte offset of that text in the tree walked.
        parent (Occurrence | None): the node the text was evaluated
            from, None for a typed line.
    """

    text: str
    base: int
    parent: Occurrence | None


def root_of(node: Any) -> Any:
    """The root of the tree a node belongs to.

    Args:
        node (Any): a tree-sitter node.
    """
    root = node
    while root.parent is not None:
        root = root.parent
    return root


def root_frame(node: Any, parent: Occurrence | None) -> Frame:
    """The frame of the tree a node belongs to: the text its parse read,
    at that parse's own offsets.

    The one rule both readers share. The gate builds it from the node
    it runs, and the pass from the tree it walks, so a stored function
    body is placed relative to its definition. Reparsing that source in
    another worker gives its commands the same approval locations.

    Args:
        node (Any): any node of the tree.
        parent (Occurrence | None): the node the tree's text was
            evaluated from, None for a typed line.
    """
    root = node
    while root.parent is not None and root.type != "function_definition":
        root = root.parent
    if root.type == "function_definition":
        root = _definition_root(root)
    return Frame(get_text(root), root.start_byte, parent)


def _definition_root(node: Any) -> Any:
    """A function definition with the redirects stored with it.

    Args:
        node (Any): a ``function_definition`` node.
    """
    parent = node.parent
    if parent is not None and parent.type == "redirected_statement":
        return parent
    return node


def definition_frame(node: Any, frame: Frame) -> Frame:
    """The frame of a function body as a pass walks its definition.

    The body runs from its own parse of the stored source, so its
    commands stand at offsets from the definition, under the
    definition's own place on the line: two definitions of one text are
    two places, each needing a nod of its own.

    Args:
        node (Any): the ``function_definition`` node.
        frame (Frame): the scope the definition was walked in.
    """
    root = _definition_root(node)
    return Frame(get_text(root), root.start_byte, occurrence_in(root, frame))


def defined_at(node: Any, handed: HandOff | None) -> Occurrence | None:
    """The place a function definition the executor runs stands on its
    line, which the body's commands stand under when it is called;
    None outside a line.

    Args:
        node (Any): the ``function_definition`` node.
        handed (HandOff | None): the line's hand-off.
    """
    if handed is None:
        return None
    root = _definition_root(node)
    if root.parent is None:
        return occurrence_in(
            root, Frame(get_text(root), root.start_byte, handed.origin)
        )
    return occurrence_in(root, root_frame(root.parent, handed.origin))


def _enclosing_definition(node: Any) -> Any:
    """The nearest ``function_definition`` at or above a node, or None.

    Args:
        node (Any): any node of the tree.
    """
    current = node.parent
    while current is not None and current.type != "function_definition":
        current = current.parent
    return current


def _definition_origin(
    definition: Any, line: Any, session: SessionState, handed: HandOff
) -> Occurrence | None:
    """The place a call runs a definition's body under, as the gate will
    find it: ``defined_at`` for one written on this line (under the
    definition holding it, for one written inside another), the stored
    site for a body parsed from the session's table, None for one whose
    site is gone.

    Args:
        definition (Any): the ``function_definition`` node.
        line (Any): the root of the line's own tree.
        session (SessionState): the session running the line.
        handed (HandOff): the line's hand-off.
    """
    outer = _enclosing_definition(definition)
    if outer is not None:
        frame = root_frame(definition.parent, handed.origin)
        origin = _definition_origin(outer, line, session, handed)
        parent = origin if origin is not None else handed.origin
        root = _definition_root(definition)
        return occurrence_in(root, Frame(frame.text, frame.base, parent))
    # Nodes are fresh objects per read, so the trees are told apart by
    # their roots' ids.
    if root_of(definition).id == line.id:
        return defined_at(definition, handed)
    name = get_function_name(definition)
    site = session._function_sites.get(name)
    if site is None or site.source != session.functions.get(name):
        return None
    return site.origin


def gate_frame(
    node: Any, line: Any, session: SessionState, handed: HandOff
) -> Frame:
    """The frame a node's gate will read it in, for a pass that reads it
    ahead of the gate: its own tree's, and for a node in a function body
    under the place the call runs the body under.

    Args:
        node (Any): a node of the line's tree or of a stored body.
        line (Any): the root of the line's own tree.
        session (SessionState): the session running the line.
        handed (HandOff): the line's hand-off.
    """
    frame = root_frame(node, handed.origin)
    definition = (
        node
        if node.type == "function_definition"
        else _enclosing_definition(node)
    )
    if definition is None:
        return frame
    origin = _definition_origin(definition, line, session, handed)
    return frame if origin is None else Frame(frame.text, frame.base, origin)


def line_frame(text: str, parent: Occurrence) -> Frame:
    """The frame of a line a word runs (``eval``, ``sh -c``), which the
    pass parses on its own exactly as the nested evaluation will.

    Args:
        text (str): the line as the word runs it.
        parent (Occurrence): the command running it.
    """
    return Frame(text, 0, parent)


def argv_frame(argv: Sequence[str], parent: Occurrence) -> Frame:
    """The frame of the line a command hands the evaluator for words it
    was given already split (``command``, ``env``, ``timeout``,
    ``xargs``), spelled as those builtins spell it: joined with shlex,
    so an operand holding a space survives the re-parse as one word.

    The nested gate parses that spelling, so the pass has to compute the
    occurrence on it. Joined with a plain space, ``cat '/data/secret
    file'`` was read as ``cat /data/secret file`` and the gate could not
    find the grant claimed for it.

    Args:
        argv (Sequence[str]): the command's words, name first.
        parent (Occurrence): the command running them.
    """
    return line_frame(shlex.join(argv), parent)


def occurrence_in(node: Any, frame: Frame) -> Occurrence:
    """Where a node stands, as a parse of the frame's text would place
    it.

    Args:
        node (Any): the command's tree-sitter node.
        frame (Frame): the scope it was walked in.
    """
    return Occurrence(
        frame.parent,
        frame.text,
        node.start_byte - frame.base,
        node.end_byte - frame.base,
    )


def whole_occurrence(frame: Frame) -> Occurrence:
    """The occurrence of a frame's whole text, for words a command runs
    without a parse of their own (``xargs cat``, ``find -exec``).

    The end is measured as the parser measures it, in bytes: a nested
    gate that parses the same text places its command by ``end_byte``,
    and an end counted in code points fell short of it by one per
    multibyte character, so the grant claimed here was hidden from it.

    Args:
        frame (Frame): the scope holding the words.
    """
    return Occurrence(
        frame.parent, frame.text, 0, byte_offset(frame.text, len(frame.text))
    )


def body_frame(node: Any, frame: Frame) -> Frame | None:
    """The frame of a substitution's body, as the nested line that
    evaluates it will parse it: ``$( )``, ``<( )`` or ``>( )``, with
    the whitespace tree-sitter folds into the opening token set aside
    as expansion sets it aside.

    Args:
        node (Any): the substitution node.
        frame (Frame): the scope the substitution was walked in.

    Returns:
        The body's frame, or None for a node that is not a
        substitution the evaluator would run.
    """
    text = get_text(node)
    prefix = len(text) - len(text.lstrip())
    raw = text[prefix:]
    for opener, closer in SUBSTITUTION_DELIMITERS:
        if raw.startswith(opener) and raw.endswith(closer):
            body = raw[len(opener) : len(raw) - len(closer)]
            base = node.start_byte + byte_offset(text, prefix) + len(opener)
            return Frame(body, base, occurrence_in(node, frame))
    return None


def part_of(occurrence: Occurrence, start: int, end: int) -> Occurrence:
    """The occurrence of one span of a node's text, for a node that
    holds several lines: a backtick region, which tree-sitter lexes as
    one node when the pairs touch and the evaluator splits again. Each
    pair is its own place on the line, as it would be had the grammar
    kept them apart.

    Args:
        occurrence (Occurrence): the node's place.
        start (int): where the span starts in the node's text, in the
            parser's offsets.
        end (int): the offset after its last byte.
    """
    return Occurrence(
        occurrence.parent,
        occurrence.source,
        occurrence.start + start,
        occurrence.start + end,
    )


def segment_frames(node: Any, frame: Frame) -> list[Frame]:
    """The frames of the lines a backtick region runs, one per pair,
    each to be parsed on its own under the pair's own place on the
    line; empty for a node that is not a backtick region.

    The region's subtree is not what runs: tree-sitter lexes touching
    pairs as one node and merges their commands into one, so the pass
    reads the region as the evaluator does, split by the one lexer
    both share (``split_backtick_region``), with the folded whitespace
    set aside first as expansion sets it aside.

    Args:
        node (Any): the substitution node.
        frame (Frame): the scope the region was walked in.
    """
    text = get_text(node)
    prefix = len(text) - len(text.lstrip())
    raw = text[prefix:]
    if not (raw.startswith("`") and raw.endswith("`")):
        return []
    at = occurrence_in(node, frame)
    return [
        line_frame(
            s.text,
            part_of(
                at,
                byte_offset(text, prefix + s.start),
                byte_offset(text, prefix + s.end),
            ),
        )
        for s in split_backtick_region(raw)
        if s.command
    ]


def occurrence_of(
    node: Any, handed: HandOff, span: tuple[int, int] | None = None
) -> Occurrence:
    """Where a node the executor runs stands, on the line it runs in.

    Args:
        node (Any): the node about to run or be evaluated.
        handed (HandOff): the line's hand-off, whose ``origin`` is the
            node the line's text was evaluated from.
        span (tuple[int, int] | None): the span within the node's text
            that runs, when the node holds several lines.
    """
    at = occurrence_in(node, root_frame(node, handed.origin))
    return at if span is None else part_of(at, *span)


def evaluated_from(
    node: Any, handed: HandOff, span: tuple[int, int] | None = None
) -> HandOff:
    """The hand-off a line read from a node's text runs on.

    Every re-parse the executor runs is a line of its own: the body a
    substitution expands, the words ``eval`` or ``xargs`` hand on, the
    line an alias invocation rewrites to. It runs under the hand-off of
    the subtree reading it and stands at the node whose text it is, so
    its commands are placed where the outer pass placed them, and one
    text read from two nodes (``c && c`` under one alias) is two places
    on the line, each needing a nod of its own. What its gates claim
    goes back to that hand-off when it ends (``Decisions.hand_up``).

    Args:
        node (Any): the node whose text the line is read from.
        handed (HandOff): the hand-off of the subtree running the node.
        span (tuple[int, int] | None): the span within the node's text
            that runs, when the node holds several lines.
    """
    return HandOff(parent=handed, origin=occurrence_of(node, handed, span))


def claimant_for(node: Any, handed: HandOff | None) -> Claimant | None:
    """The reader of the ledger for one command the executor runs, None
    outside a line.

    Args:
        node (Any): the command's tree-sitter node.
        handed (HandOff | None): the line's hand-off.
    """
    if handed is None:
        return None
    return Claimant(handed, occurrence_of(node, handed))
