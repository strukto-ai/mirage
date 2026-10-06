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

from mirage.shell.bytes import encode_text
from mirage.shell.parse.assignment import repair_assignments
from mirage.shell.parse.diagnostics import diagnose
from mirage.shell.parse.engine import BASH_LANGUAGE as BASH_LANGUAGE
from mirage.shell.parse.engine import TS_PARSER as TS_PARSER
from mirage.shell.parse.heredoc import heredoc_operators
from mirage.shell.parse.heredoc.lower import (
    drop_source_bytes,
    lower_heredocs,
    rebase_source,
)
from mirage.shell.parse.heredoc.node import HeredocNode
from mirage.shell.parse.heredoc.reader import discover_heredocs
from mirage.shell.parse.heredoc.types import HeredocSource
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.parse.recovery import (
    _failed_arith_openers,
    _is_arithmetic,
    _operator_source,
    _parse_bytes,
    _repair_for_headers,
    _repair_orphaned_dollars,
    _repair_redirect_dashes,
    _statement_boundaries,
)
from mirage.shell.parse.source import (
    continuation_bytes,
)
from mirage.shell.parse.source import (
    join_continuations as join_continuations,
)
from mirage.shell.parse.source import (
    source_offsets as source_offsets,
)
from mirage.shell.parse.timing import lower_timing, wrap_timing
from mirage.shell.types import TSNodeLike


def parse(command: str) -> TSNodeLike:
    """Parse shell structure after the source reader gathers heredocs.

    Bodies become inline expansion words with reader-owned input metadata.
    The resulting nodes retain their original source for nested evaluation;
    neither delimiter recognition nor expansion depends on heredoc tokens.

    A leading ``((`` is lexed as the arithmetic opener and the lexer
    cannot back out, so a subshell that immediately opens another
    subshell (``((echo a); echo b)``) fails to parse. Bash resolves the
    same ambiguity by trying the arithmetic command and reparsing as
    nested subshells when that fails; this does the same, splitting only
    the openers that already sit inside an error and keeping the retry
    only if it parses cleanly. Commands that parse today are untouched,
    so no working command's byte offsets move.

    A later unbraced ``$var`` followed by a name-terminating character
    is mis-lexed by the grammar, leaving a literal ``$`` token behind
    (see _orphaned_dollar_offsets); those expansions are rebraced and
    the line reparsed, so the returned tree can spell ``$id`` as
    ``${id}``.

    Args:
        command (str): shell source to parse.

    Returns:
        TSNodeLike: root node, or the original errored root when no
        reparse helps.
    """
    original = encode_text(command)
    source = None
    if b"<<" in original:
        # The operators are read off a tree that lexes `0<<EOF` as one.
        hinted = TS_PARSER.parse(original).root_node
        lexed = _operator_source(original, hinted)
        if lexed != original:
            hinted = TS_PARSER.parse(lexed).root_node
        documents = discover_heredocs(original, heredoc_operators(hinted))
        if documents:
            source = lower_heredocs(original, documents)
    if source is not None:
        source = drop_source_bytes(source, continuation_bytes(source.source))
    data = (
        source.source
        if source is not None
        else encode_text(join_continuations(command))
    )
    timing_marks: list[tuple[int, str, bool, int, int]] = []
    if b"time" in data or b"!" in data:
        if source is None:
            source = drop_source_bytes(
                HeredocSource(
                    original, original, tuple(range(len(original) + 1)), ()
                ),
                continuation_bytes(original),
            )
        source, timing_marks = lower_timing(TS_PARSER, source)
        data = source.source
    data = _statement_boundaries(data)
    root = _parse_bytes(data)
    if root.has_error:
        # Sitting inside an ERROR is not evidence that an opener is
        # broken: tree-sitter's error region swallows neighbouring
        # tokens, so a valid `((i++))` next to a bad opener reports as
        # errored too. Splitting it would silently turn arithmetic into
        # a subshell running `i++`, which is a wrong parse rather than a
        # rejected one. Each opener is judged on its own span instead,
        # in byte space throughout, because the offsets tree-sitter
        # reports are byte offsets.
        offsets = [
            offset
            for offset in set(_failed_arith_openers(root))
            if not _is_arithmetic(data, offset)
        ]
        if offsets:
            retried_data = data
            for offset in sorted(offsets, reverse=True):
                retried_data = (
                    retried_data[: offset + 1]
                    + b" "
                    + retried_data[offset + 1 :]
                )
            retried = _parse_bytes(retried_data)
            if not retried.has_error:
                root = retried
                data = retried_data
    root, data = _repair_redirect_dashes(root, data)
    if b"for" in data or b"select" in data:
        root, data = _repair_for_headers(root, data)
    if b"$" in data:
        root = _repair_orphaned_dollars(root, data)
    root = repair_assignments(
        root, data[: root.start_byte] + (root.text or b"")
    )
    if source is None:
        return root
    repaired = source.source[: root.start_byte] + (root.text or b"")
    source = rebase_source(source, repaired)
    mapped = HeredocNode(root, source)
    return (
        wrap_timing(mapped, source, timing_marks) if timing_marks else mapped
    )


def parse_program(command: str) -> ParsedProgram:
    root = parse(command)
    offsets = tuple(source_offsets(command, root))
    return ParsedProgram(
        command, root, offsets, diagnose(root, offsets, parse)
    )
