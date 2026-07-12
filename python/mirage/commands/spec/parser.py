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

from mirage.commands.spec.constants import NUMERIC_SHORT, flag_kwarg_name
from mirage.commands.spec.types import CommandSpec, OperandKind, ParsedArgs
from mirage.utils.path import resolve_path


def _set_value_flag(
    flags: dict[str, str | bool | list[str]],
    name: str,
    value: str,
    repeat_flags: set[str],
) -> None:
    if name in repeat_flags:
        prev = flags.get(name)
        if isinstance(prev, list):
            prev.append(value)
        else:
            flags[name] = [value]
    else:
        flags[name] = value


def _match_mixed_cluster(
    tok: str,
    bool_flags: set[str],
    value_flags: set[str],
) -> tuple[list[str], str, str | None] | None:
    """Match a getopt-style cluster of bool flags ending in a value flag.

    Args:
        tok (str): token like "-ne" or "-nepat".
        bool_flags (set[str]): single-dash boolean flag names.
        value_flags (set[str]): single-dash value flag names.

    Returns:
        tuple[list[str], str, str | None] | None: (bool flag names, value
            flag name, attached value or None when the value comes from the
            next token), or None when any character is unknown or no value
            flag terminates the cluster.
    """
    bools: list[str] = []
    chars = tok[1:]
    for idx, ch in enumerate(chars):
        name = f"-{ch}"
        if name in bool_flags:
            bools.append(name)
            continue
        if name in value_flags:
            rest = chars[idx + 1:]
            return bools, name, (rest if rest else None)
        return None
    return None


def parse_command(
    spec: CommandSpec,
    argv: list[str],
    cwd: str,
) -> ParsedArgs:
    bool_flags: set[str] = set()
    value_flags: set[str] = set()
    long_bool_flags: set[str] = set()
    long_value_flags: set[str] = set()
    long_optional_flags: set[str] = set()
    value_flag_kinds: dict[str, OperandKind] = {}
    repeat_flags: set[str] = set()
    numeric_shorthand_flag: str | None = None
    for opt in spec.options:
        if opt.short:
            if opt.value_kind == OperandKind.NONE:
                bool_flags.add(opt.short)
            else:
                value_flags.add(opt.short)
                value_flag_kinds[opt.short] = opt.value_kind
                if opt.repeatable:
                    repeat_flags.add(opt.short)
                if opt.numeric_shorthand:
                    numeric_shorthand_flag = opt.short
        if opt.long:
            if opt.value_kind == OperandKind.NONE:
                long_bool_flags.add(opt.long)
            elif opt.value_optional:
                # GNU optional argument: bare form is boolean, value only
                # attaches via `=`; a detached next token is an operand.
                long_bool_flags.add(opt.long)
                long_optional_flags.add(opt.long)
            else:
                long_value_flags.add(opt.long)
                value_flag_kinds[opt.long] = opt.value_kind
                if opt.repeatable:
                    repeat_flags.add(opt.long)

    rest_kind: OperandKind | None = (spec.rest.kind
                                     if spec.rest is not None else None)

    cache_paths: list[str] = []
    filtered_argv: list[str] = []
    # orig_indices[j] = argv position of filtered_argv[j]
    orig_indices: list[int] = []
    i = 0
    while i < len(argv):
        if argv[i] == "--cache":
            i += 1
            while i < len(argv) and not argv[i].startswith("-"):
                cache_paths.append(resolve_path(argv[i], cwd))
                i += 1
        else:
            filtered_argv.append(argv[i])
            orig_indices.append(i)
            i += 1

    flags: dict[str, str | bool | list[str]] = {}
    raw_args: list[str] = []
    # raw_indices[k] = argv position of raw_args[k]
    raw_indices: list[int] = []
    # Per-position operand kinds aligned with the caller's argv (None =
    # flag token or ignored word). Positions, not value sets, so the
    # same word can be TEXT in one slot and PATH in another:
    #   grep  *.txt  *.txt               -> [TEXT, PATH]
    #   find  /data  -name  *.txt        -> [PATH, None, TEXT]
    #   grep  --cache  /c  pat  f.txt    -> [None, None, TEXT, PATH]
    # orig_indices/raw_indices map the parser's shrunken views back to
    # argv slots (filtered_argv drops --cache tokens, raw_args keeps
    # only operands); kinds must be written at the original positions
    # or one dropped token shifts every later kind onto the wrong word.
    word_kinds: list[OperandKind | None] = [None] * len(argv)
    warnings: list[str] = []
    invalid_options: list[str] = []
    needs_value_options: list[str] = []
    # Free-text commands (echo/python/bash-style TEXT rest) keep unknown
    # dash tokens verbatim; elsewhere they are dropped with a warning so a
    # stray flag never corrupts pattern/path classification.
    lenient_dash_operands = rest_kind == OperandKind.TEXT
    i = 0
    end_of_flags = False

    while i < len(filtered_argv):
        tok = filtered_argv[i]

        if tok == "--" and not end_of_flags:
            end_of_flags = True
            i += 1
            continue

        if end_of_flags:
            raw_args.append(tok)
            raw_indices.append(orig_indices[i])
            i += 1
            continue

        if tok.startswith("--"):
            if tok in long_bool_flags:
                flags[tok] = True
                i += 1
            elif tok in long_value_flags and i + 1 < len(filtered_argv):
                _set_value_flag(flags, tok, filtered_argv[i + 1], repeat_flags)
                word_kinds[orig_indices[i + 1]] = value_flag_kinds[tok]
                i += 2
            else:
                eq = tok.find("=")
                if eq != -1 and (tok[:eq] in long_value_flags
                                 or tok[:eq] in long_optional_flags):
                    _set_value_flag(flags, tok[:eq], tok[eq + 1:],
                                    repeat_flags)
                elif tok in long_value_flags:
                    # Declared value flag at end of line with no argument.
                    needs_value_options.append(tok)
                elif lenient_dash_operands:
                    raw_args.append(tok)
                    raw_indices.append(orig_indices[i])
                else:
                    invalid_options.append(tok)
                i += 1
            continue

        if tok.startswith("-") and len(tok) > 1:
            if numeric_shorthand_flag is not None and NUMERIC_SHORT.match(tok):
                flags[numeric_shorthand_flag] = tok[1:]
                i += 1
                continue
            matched_value = False
            for vf in value_flags:
                if tok == vf and i + 1 < len(filtered_argv):
                    _set_value_flag(flags, vf, filtered_argv[i + 1],
                                    repeat_flags)
                    word_kinds[orig_indices[i + 1]] = value_flag_kinds[vf]
                    i += 2
                    matched_value = True
                    break
                if tok.startswith(vf) and len(tok) > len(vf):
                    _set_value_flag(flags, vf, tok[len(vf):], repeat_flags)
                    i += 1
                    matched_value = True
                    break
            if matched_value:
                continue

            if tok in bool_flags:
                flags[tok] = True
                i += 1
                continue

            all_bool = True
            for ch in tok[1:]:
                if f"-{ch}" not in bool_flags:
                    all_bool = False
                    break
            if all_bool and len(tok) > 1:
                for ch in tok[1:]:
                    flags[f"-{ch}"] = True
                i += 1
                continue

            mixed = _match_mixed_cluster(tok, bool_flags, value_flags)
            if mixed is not None:
                cluster_bools, vflag, attached = mixed
                if attached is not None:
                    for name in cluster_bools:
                        flags[name] = True
                    _set_value_flag(flags, vflag, attached, repeat_flags)
                    i += 1
                    continue
                if i + 1 < len(filtered_argv):
                    for name in cluster_bools:
                        flags[name] = True
                    _set_value_flag(flags, vflag, filtered_argv[i + 1],
                                    repeat_flags)
                    word_kinds[orig_indices[i + 1]] = value_flag_kinds[vflag]
                    i += 2
                    continue

            if lenient_dash_operands or NUMERIC_SHORT.match(tok):
                raw_args.append(tok)
                raw_indices.append(orig_indices[i])
            elif tok in value_flags or (mixed is not None
                                        and mixed[2] is None):
                # A declared value flag (alone or ending a cluster) with no
                # argument left on the line. GNU reports the flag character.
                needy = tok[1:] if tok in value_flags else mixed[1][1:]
                needs_value_options.append(needy)
            else:
                # GNU reports the first offending character, not the token.
                bad = tok[1:2]
                for ch in tok[1:]:
                    if (f"-{ch}" not in bool_flags
                            and f"-{ch}" not in value_flags):
                        bad = ch
                        break
                invalid_options.append(bad)
            i += 1
            continue

        raw_args.append(tok)
        raw_indices.append(orig_indices[i])
        i += 1

    positional: tuple[OperandKind,
                      ...] = tuple(op.kind for op in spec.positional
                                   if not any(name in flags
                                              for name in op.provided_by))

    # Overflow operands past the declared positional slots pass through
    # classified like the last slot (TEXT when there is none), so a
    # fixed-arity command receives them and raises its own extra-operand
    # UsageError (#452). The parser classifies, it never drops or raises.
    overflow_kind = positional[-1] if positional else OperandKind.TEXT

    classified: list[tuple[str, OperandKind]] = []
    raw_operands: list[tuple[str, OperandKind]] = []
    for j, arg in enumerate(raw_args):
        if j < len(positional):
            kind = positional[j]
        elif rest_kind is not None:
            kind = rest_kind
        else:
            kind = overflow_kind
        if kind == OperandKind.PATH:
            classified.append((resolve_path(arg, cwd), OperandKind.PATH))
            raw_operands.append((arg, OperandKind.PATH))
        else:
            classified.append((arg, OperandKind.TEXT))
            raw_operands.append((arg, OperandKind.TEXT))
        word_kinds[raw_indices[j]] = kind

    path_flag_values: list[str] = []
    for flag_name, kind in value_flag_kinds.items():
        if kind != OperandKind.PATH or flag_name not in flags:
            continue
        value = flags[flag_name]
        if isinstance(value, list):
            resolved_list = [resolve_path(part, cwd) for part in value]
            flags[flag_name] = resolved_list
            path_flag_values.extend(resolved_list)
        elif isinstance(value, str):
            resolved = resolve_path(value, cwd)
            flags[flag_name] = resolved
            path_flag_values.append(resolved)

    text_flag_values: list[str] = []
    for flag_name, kind in value_flag_kinds.items():
        if kind != OperandKind.TEXT or flag_name not in flags:
            continue
        value = flags[flag_name]
        if isinstance(value, list):
            text_flag_values.extend(value)
        elif isinstance(value, str):
            text_flag_values.append(value)

    return ParsedArgs(
        flags=flags,
        args=classified,
        cache_paths=cache_paths,
        path_flag_values=path_flag_values,
        raw_operands=raw_operands,
        text_flag_values=text_flag_values,
        warnings=warnings,
        word_kinds=word_kinds,
        invalid_options=invalid_options,
        needs_value_options=needs_value_options,
    )


def parse_to_kwargs(parsed: ParsedArgs) -> dict[str, str | bool | list[str]]:
    result: dict[str, str | bool | list[str]] = {}
    for key, value in parsed.flags.items():
        result[flag_kwarg_name(key)] = value
    return result
