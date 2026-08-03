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

from collections.abc import Container

import tree_sitter

from mirage.commands.spec import SPECS
from mirage.runtime.policy.types import ParsedCommand
from mirage.shell.types import NodeType

_WORD_TYPES = (NodeType.COMMAND_NAME, NodeType.WORD, NodeType.STRING,
               NodeType.RAW_STRING, NodeType.NUMBER, NodeType.CONCATENATION)


def parsed_commands(
    ast: tree_sitter.Node, clis: Container[str] = frozenset()
) -> tuple[ParsedCommand, ...]:
    """Distill a parsed line into one ParsedCommand per command.

    Args:
        ast (tree_sitter.Node): the parsed tree-sitter root node.
        clis (Container[str]): installed CLI head words; a command whose
            name is one of them carries it as ``cli``.
    """
    commands: list[ParsedCommand] = []
    stack = [ast]
    while stack:
        node = stack.pop()
        if node.type == "command":
            words = tuple(
                child.text.decode() for child in node.children
                if child.type in _WORD_TYPES and child.text is not None)
            if words:
                commands.append(
                    ParsedCommand(
                        command=words[0],
                        words=words,
                        builtin=words[0] in SPECS,
                        paths=tuple(w for w in words[1:] if w.startswith("/")),
                        cli=words[0] if words[0] in clis else None,
                    ))
        stack.extend(reversed(node.children))
    return tuple(commands)
