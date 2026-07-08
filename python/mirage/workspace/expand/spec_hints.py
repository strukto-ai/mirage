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
) -> tuple[set[str], set[str]]:
    """Classify argv into TEXT and PATH sets using a CommandSpec.

    Delegates to parse_command so flag syntax (clusters, --flag=value,
    repeatable flags, provided_by) classifies identically to dispatch,
    then maps the raw (unresolved) operand words to their kinds. Flag
    values with TEXT kind are also added to the text set.

    Examples:
        cat file.txt           → text={}, path={"file.txt"}
        grep pattern file.txt  → text={"pattern"}, path={"file.txt"}
        find /data -name *.txt → text={"*.txt"}, path={"/data"}

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
    """
    parsed = parse_command(spec, argv, cwd="/")
    text_set = {
        word
        for word, kind in parsed.raw_operands if kind == OperandKind.TEXT
    }
    path_set = {
        word
        for word, kind in parsed.raw_operands if kind == OperandKind.PATH
    }
    text_set.update(parsed.text_flag_values)
    text_set -= spec.ignore_tokens
    path_set -= spec.ignore_tokens
    return text_set, path_set
