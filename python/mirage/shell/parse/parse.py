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


from mirage.io.types import IOResult
from mirage.rs.shell import parse_shell
from mirage.shell.bytes import encode_text
from mirage.shell.parse.program import ParsedProgram
from mirage.shell.types import TSNodeLike


def parse(
    command: str, aliases: frozenset[str] = frozenset(), extglob: bool = True
) -> TSNodeLike:
    """Parse a line as bash reads it.

    The parser folds each heredoc body into its line as a ``<`` redirect
    from a double-quoted word, whose node carries the heredoc, and drops
    the line continuations, so a word's text is what bash reads. Each
    node's ``offsets`` map the text back to the line as typed.

    Args:
        command (str): shell source to parse.
        aliases (frozenset[str]): the names the shell expands as aliases;
            one is a command where a command starts.
        extglob (bool): whether extglob's pattern groups are on.

    Returns:
        TSNodeLike: root node; a line the parser refuses ends in an
        ``ERROR`` node, and its ``error`` holds bash's refusal.
    """
    return parse_shell(command, aliases, extglob).root_node


def parse_program(
    command: str, aliases: frozenset[str] = frozenset(), extglob: bool = True
) -> ParsedProgram:
    """Parse a line into a program its holders release when done with it.

    Args:
        command (str): shell source to parse.
        aliases (frozenset[str]): the names the shell expands as aliases.
        extglob (bool): whether extglob's pattern groups are on.
    """
    return ParsedProgram(
        command, parse_shell(command, aliases, extglob).root_node
    )


def syntax_refusal(
    root: TSNodeLike, head: str, first: int, utf8: bool
) -> IOResult | None:
    """What a line bash refuses yields: its diagnostic and status. Status
    2 is a syntax error, 1 an array bash cannot read, 127 a substitution
    whose body bash cannot parse.

    Args:
        root (TSNodeLike): the line's root node.
        head (str): what each diagnostic line leads with, before its line
            (``bash: -c: ``, ``bash: eval: ``).
        first (int): the line the input's first row is.
        utf8 (bool): whether the shell's locale is UTF-8, which decides
            how a token holding a byte past ASCII is named.

    Returns:
        IOResult | None: None when bash reads the line.
    """
    error = getattr(root, "error", None)
    if error is None:
        return None
    message = getattr(root, "refusal")(encode_text(head), first, utf8)
    return IOResult(exit_code=error[1], stderr=message)
