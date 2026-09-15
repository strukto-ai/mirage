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

from collections.abc import Callable, Container, Iterator

from mirage.commands.spec import SPECS
from mirage.runtime.routing.types import ParsedCommand
from mirage.shell.types import NodeType, TSNodeLike

_WORD_TYPES = (NodeType.COMMAND_NAME, NodeType.WORD, NodeType.STRING,
               NodeType.RAW_STRING, NodeType.ANSI_C_STRING,
               NodeType.TRANSLATED_STRING, NodeType.NUMBER,
               NodeType.CONCATENATION)


def command_nodes(ast: TSNodeLike) -> Iterator[TSNodeLike]:
    """Every command node of a parsed line, in source order, nested
    ones included (a substitution's command follows the word holding
    it).

    Args:
        ast (TSNodeLike): the parsed tree-sitter root node.
    """
    stack = [ast]
    while stack:
        node = stack.pop()
        if node.type == "command":
            yield node
        stack.extend(reversed(node.children))


def parsed_commands(
    ast: TSNodeLike,
    clis: Container[str] = frozenset(),
    match_command_prefix: Callable[[list[str]], int] | None = None,
) -> tuple[ParsedCommand, ...]:
    """Distill a parsed line into one ParsedCommand per command.

    Args:
        ast (TSNodeLike): the parsed tree-sitter root node.
        clis (Container[str]): installed CLI head words; a command whose
            name is one of them carries it as ``cli``.
        match_command_prefix (Callable | None): the workspace's registered
            command-prefix matcher; absent means single-word names.
    """
    commands: list[ParsedCommand] = []
    for node in command_nodes(ast):
        words = tuple(child.text.decode() for child in node.children
                      if child.type in _WORD_TYPES and child.text is not None)
        if words:
            consumed = match_command_prefix(
                list(words)) if match_command_prefix else 1
            name = " ".join(words[:consumed])
            commands.append(
                ParsedCommand(
                    command=name,
                    words=words,
                    builtin=name in SPECS,
                    paths=tuple(w for w in words[consumed:]
                                if w.startswith("/")),
                    cli=words[0] if words[0] in clis else None,
                ))
    return tuple(commands)
