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

from mirage.commands.spec.types import CommandSpec, OperandKind


def classify_argv_by_spec(
    spec: CommandSpec,
    argv: list[str],
) -> tuple[set[str], set[str]]:
    """Classify argv into TEXT and PATH sets using a CommandSpec.

    Strips flags from argv, then assigns kinds based on
    spec.positional and spec.rest. Flag values with TEXT kind
    are also added to the text set. Returns (text_args, path_args)
    with the original (unresolved) arg values.

    Examples:
        cat file.txt           → text={}, path={"file.txt"}
        grep pattern file.txt  → text={"pattern"}, path={"file.txt"}
        find /data -name *.txt → text={"*.txt"}, path={"/data"}
        echo hello world       → text={"hello", "world"}, path={}

    Args:
        spec (CommandSpec): command specification with flags/positional/rest.
        argv (list[str]): command arguments (without command name).
    """
    bool_flags: set[str] = set()
    value_flags: set[str] = set()
    value_flag_kinds: dict[str, OperandKind] = {}
    long_bool_flags: set[str] = set()
    long_value_flags: set[str] = set()
    for opt in spec.options:
        if opt.short:
            if opt.value_kind == OperandKind.NONE:
                bool_flags.add(opt.short)
            else:
                value_flags.add(opt.short)
                value_flag_kinds[opt.short] = opt.value_kind
        if opt.long:
            if opt.value_kind == OperandKind.NONE:
                long_bool_flags.add(opt.long)
            else:
                long_value_flags.add(opt.long)
                value_flag_kinds[opt.long] = opt.value_kind

    positional = tuple(op.kind for op in spec.positional)
    rest_kind = spec.rest.kind if spec.rest is not None else None

    raw_args: list[str] = []
    flag_text_values: set[str] = set()
    i = 0
    end_of_flags = False
    while i < len(argv):
        tok = argv[i]
        if tok == "--" and not end_of_flags:
            end_of_flags = True
            i += 1
            continue
        if end_of_flags:
            raw_args.append(tok)
            i += 1
            continue
        if tok in spec.ignore_tokens:
            i += 1
            continue
        if tok.startswith("--"):
            if tok in long_value_flags and i + 1 < len(argv):
                if value_flag_kinds.get(tok) == OperandKind.TEXT:
                    flag_text_values.add(argv[i + 1])
                i += 2
            else:
                if tok not in long_bool_flags:
                    raw_args.append(tok)
                i += 1
            continue
        if tok.startswith("-") and len(tok) > 1:
            matched_value = False
            for vf in value_flags:
                if tok == vf and i + 1 < len(argv):
                    if value_flag_kinds.get(vf) == OperandKind.TEXT:
                        flag_text_values.add(argv[i + 1])
                    i += 2
                    matched_value = True
                    break
                if tok.startswith(vf) and len(tok) > len(vf):
                    if value_flag_kinds.get(vf) == OperandKind.TEXT:
                        flag_text_values.add(tok[len(vf):])
                    i += 1
                    matched_value = True
                    break
            if matched_value:
                continue
            if tok in bool_flags:
                i += 1
                continue
            all_bool = all(f"-{ch}" in bool_flags for ch in tok[1:])
            if all_bool and len(tok) > 1:
                i += 1
                continue
            raw_args.append(tok)
            i += 1
            continue
        raw_args.append(tok)
        i += 1

    text_set: set[str] = set()
    path_set: set[str] = set()
    for j, arg in enumerate(raw_args):
        if j < len(positional):
            kind = positional[j]
        elif rest_kind is not None:
            kind = rest_kind
        else:
            continue
        if kind == OperandKind.TEXT:
            text_set.add(arg)
        elif kind == OperandKind.PATH:
            path_set.add(arg)
    text_set |= flag_text_values
    return text_set, path_set
