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
from mirage.shell.parse.engine import TS_PARSER
from mirage.shell.parse.heredoc import heredoc_operators
from mirage.shell.parse.heredoc.lower import (
    drop_source_bytes,
    lower_heredocs,
    rebase_source,
)
from mirage.shell.parse.heredoc.node import HeredocNode
from mirage.shell.parse.heredoc.reader import (
    discover_heredocs,
    read_planned,
)
from mirage.shell.parse.heredoc.types import HeredocSource
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.parse.recovery import (
    failed_arith_openers,
    is_arithmetic,
    operator_source,
    parse_protected,
    repair_for_headers,
    repair_orphaned_dollars,
    repair_redirect_dashes,
    statement_boundaries,
)
from mirage.shell.parse.source import (
    continuation_bytes,
    join_continuations,
    source_offsets,
)
from mirage.shell.parse.syntax import heredoc_plan, pattern_source
from mirage.shell.parse.timing import lower_timing, wrap_timing
from mirage.shell.types import TSNodeLike


def parse(command: str) -> TSNodeLike:
    """Parse shell structure after the source reader gathers heredocs.

    Bodies become inline expansion words with reader-owned input metadata.
    The resulting nodes retain their original source for nested evaluation;
    neither delimiter recognition nor expansion depends on heredoc tokens.
    A line the reader refuses takes its heredocs from the grammar's.

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
        plan = heredoc_plan(command)
        if plan is not None:
            documents = read_planned(original, plan)
        else:
            patterned = pattern_source(original)
            hinted = TS_PARSER.parse(patterned).root_node
            lexed = operator_source(patterned, hinted)
            if lexed != patterned:
                hinted = TS_PARSER.parse(lexed).root_node
            documents = discover_heredocs(original, heredoc_operators(hinted))
        if documents:
            source = lower_heredocs(
                original, documents, () if plan is None else plan.closes
            )
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
    data = statement_boundaries(data)
    root = parse_protected(data)
    if root.has_error:
        offsets = [
            offset
            for offset in set(failed_arith_openers(root))
            if not is_arithmetic(data, offset)
        ]
        if offsets:
            retried_data = data
            for offset in sorted(offsets, reverse=True):
                retried_data = (
                    retried_data[: offset + 1]
                    + b" "
                    + retried_data[offset + 1 :]
                )
            retried = parse_protected(retried_data)
            if not retried.has_error:
                root = retried
                data = retried_data
    root, data = repair_redirect_dashes(root, data)
    if b"for" in data or b"select" in data:
        root, data = repair_for_headers(root, data)
    if b"$" in data:
        root = repair_orphaned_dollars(root, data)
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
    """Parse a line into a program its holders release when done with it.

    Args:
        command (str): shell source to parse.
    """
    root = parse(command)
    return ParsedProgram(command, root, source_offsets(command, root))
