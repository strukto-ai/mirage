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
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse.constants import VERBATIM_TYPES
from mirage.shell.parse.heredoc.constants import BACKSLASH
from mirage.shell.parse.heredoc.lower import (
    drop_bytes,
    drop_source_bytes,
    rebase_source,
)
from mirage.shell.parse.heredoc.node import HeredocNode
from mirage.shell.parse.heredoc.types import HeredocSource
from mirage.shell.parse.program import ProgramNode
from mirage.shell.types import TSNodeLike


def _verbatim_spans(root: TSNodeLike) -> list[tuple[int, int]]:
    """Byte spans whose backslashes escape nothing: comments and strings
    in single quotes, ANSI-C ones included.

    Args:
        root (TSNodeLike): root of the parsed tree.
    """
    spans: list[tuple[int, int]] = []
    stack = [root]
    while stack:
        node = stack.pop()
        if node.type in VERBATIM_TYPES:
            spans.append((node.start_byte, node.end_byte))
            continue
        stack.extend(node.children)
    return sorted(spans)


def continuation_bytes(
    data: bytes, aliases: frozenset[str] = frozenset()
) -> list[int]:
    """Offsets of the bytes bash's reader deletes as line continuations.

    The reader removes ``\\<newline>`` before a token is read, so the
    halves it joins are one word (``a\\<newline>b`` is ``ab``,
    ``$\\<newline>{x}`` an expansion). Single-quoted and ANSI-C text and a comment keep
    theirs, and an escaped backslash continues nothing: only an
    odd-length run of backslashes before the newline ends in a live one.
    A live backslash ending the input continues onto nothing and goes
    too: ``echo a\\`` runs ``echo a``. A heredoc body is lowered into a
    quoted word before this runs, where every backslash it holds is
    escaped, so no body loses a byte here.

    Args:
        data (bytes): shell source.
        aliases (frozenset[str]): the names the shell expands as aliases,
            so the parse that finds quoted text reads the line it runs.
    """
    if b"\\\n" not in data and not data.endswith(b"\\"):
        return []
    spans = _verbatim_spans(parse_shell(data, aliases).root_node)
    dropped: list[int] = []
    at = 0
    index = data.find(b"\\")
    while index >= 0:
        end = index
        while end < len(data) and data[end] == BACKSLASH:
            end += 1
        while at < len(spans) and spans[at][1] <= end - 1:
            at += 1
        verbatim = at < len(spans) and spans[at][0] <= end - 1
        if (
            (end - index) % 2
            and not verbatim
            and data[end : end + 1] in (b"", b"\n")
        ):
            dropped.extend(range(end - 1, min(end + 1, len(data))))
        index = data.find(b"\\", end)
    return dropped


def source_offsets(
    command: str, root: TSNodeLike, aliases: frozenset[str] = frozenset()
) -> tuple[int, ...]:
    """Where each byte of the source ``parse`` read sits in ``command``.

    ``parse`` deletes line continuations and lowers heredocs, so a node's
    offsets index the source it read rather than the line as typed.
    Indexed by one of them, this gives the byte of ``command`` it came
    from; an inserted byte gives the byte after it.

    Args:
        command (str): the line ``root`` was parsed from.
        root (TSNodeLike): what ``parse(command)`` returned.
        aliases (frozenset[str]): the alias names ``parse`` read it with.
    """
    if isinstance(root, ProgramNode) and root.program.original == command:
        return root.program.offsets
    if isinstance(root, HeredocNode):
        return root.offsets
    data = encode_text(command)
    source = drop_source_bytes(
        HeredocSource(data, data, tuple(range(len(data) + 1)), ()),
        continuation_bytes(data, aliases),
    )
    repaired = source.source[: root.start_byte] + (root.text or b"")
    return rebase_source(source, repaired).offsets


def join_continuations(
    command: str, aliases: frozenset[str] = frozenset()
) -> str:
    """The line as bash's reader hands it on, continuations removed.

    Args:
        command (str): the raw command line.
        aliases (frozenset[str]): the names the shell expands as aliases.
    """
    data = encode_text(command)
    return decode_text(drop_bytes(data, continuation_bytes(data, aliases)))
