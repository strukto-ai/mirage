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


from mirage.rs.shell import parse_shell
from mirage.shell.bytes import encode_text
from mirage.shell.parse.heredoc import heredoc_operators
from mirage.shell.parse.heredoc.lower import drop_source_bytes, lower_heredocs
from mirage.shell.parse.heredoc.node import HeredocNode
from mirage.shell.parse.heredoc.reader import (
    discover_heredocs,
    read_planned,
)
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.parse.source import (
    continuation_bytes,
    join_continuations,
    source_offsets,
)
from mirage.shell.parse.syntax import heredoc_plan
from mirage.shell.types import TSNodeLike


def parse(command: str, aliases: frozenset[str] = frozenset()) -> TSNodeLike:
    """Parse shell structure after the source reader gathers heredocs.

    Bodies become inline expansion words with reader-owned input metadata.
    The resulting nodes retain their original source for nested evaluation;
    neither delimiter recognition nor expansion depends on heredoc tokens.
    A line the reader refuses takes its heredocs from the parser's tree.
    Line continuations are joined first, so a word's text is what bash
    reads.

    Args:
        command (str): shell source to parse.
        aliases (frozenset[str]): the names the shell expands as aliases;
            one is a command where a command starts.

    Returns:
        TSNodeLike: root node; a line the parser refuses ends in an
        ``ERROR`` node.
    """
    original = encode_text(command)
    source = None
    if b"<<" in original:
        plan = heredoc_plan(command)
        documents = (
            read_planned(original, plan)
            if plan is not None
            else discover_heredocs(
                original,
                heredoc_operators(parse_shell(original, aliases).root_node),
            )
        )
        if documents:
            source = lower_heredocs(
                original, documents, () if plan is None else plan.closes
            )
    if source is None:
        return parse_shell(
            join_continuations(command, aliases), aliases
        ).root_node
    source = drop_source_bytes(
        source, continuation_bytes(source.source, aliases)
    )
    return HeredocNode(parse_shell(source.source, aliases).root_node, source)


def parse_program(
    command: str, aliases: frozenset[str] = frozenset()
) -> ParsedProgram:
    """Parse a line into a program its holders release when done with it.

    Args:
        command (str): shell source to parse.
        aliases (frozenset[str]): the names the shell expands as aliases.
    """
    root = parse(command, aliases)
    return ParsedProgram(command, root, source_offsets(command, root, aliases))
