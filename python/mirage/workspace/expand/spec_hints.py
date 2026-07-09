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

from mirage.commands.spec.parser import parse_command
from mirage.commands.spec.types import CommandSpec, OperandKind


def spec_word_kinds(
    spec: CommandSpec,
    argv: list[str],
) -> list[OperandKind | None]:
    """Classify argv words into per-position operand kinds.

    Delegates to parse_command so flag syntax (clusters, --flag=value,
    repeatable flags, provided_by) classifies identically to dispatch.
    Kinds are positional, not value sets, so the same word can be TEXT
    in one slot and PATH in another (`grep '*.txt' *.txt`). None marks
    flag tokens and ignored words (default classification applies).

    Examples:
        cat file.txt           → [PATH]
        grep pattern file.txt  → [TEXT, PATH]
        find /data -name *.txt → [PATH, None, TEXT]

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
    """
    parsed = parse_command(spec, argv, cwd="/")
    kinds: list[OperandKind | None] = list(parsed.word_kinds)
    for i, word in enumerate(argv):
        if word in spec.ignore_tokens:
            kinds[i] = None
    return kinds
