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

from mirage.commands.spec.compile import (CompiledSpec, compile_spec,
                                          expand_long)
from mirage.commands.spec.constants import (FLOAT_VALUE, INT_VALUE,
                                            NUMERIC_SHORT, flag_kwarg_name)
from mirage.commands.spec.oldstyle import expand_old_style
from mirage.commands.spec.types import (CommandSpec, ParsedArgs,
                                        ParsedFlagValue, ValueType)
from mirage.utils.path import resolve_path


def _set_value_flag(
    flags: dict[str, ParsedFlagValue],
    cs: CompiledSpec,
    spelling: str,
    value: str,
) -> None:
    """Record a value flag occurrence under its canonical dest.

    Both spellings of one option land on the same key, so the last
    occurrence wins regardless of spelling (GNU: ``cp --update=all -u``
    is ``--update=older``) and ``multiple`` options accumulate in true
    command-line order (``sort -k1 --key=2`` is ``[1, 2]``).

    Args:
        flags (dict): parsed flag bag, updated in place.
        cs (CompiledSpec): compiled spec tables.
        spelling (str): dashed spelling as typed.
        value (str): the flag's value.
    """
    name = cs.dest_of(spelling)
    if name in cs.multiple_dests:
        prev = flags.get(name)
        if isinstance(prev, list):
            prev.append(value)
        else:
            flags[name] = [value]
    else:
        flags[name] = value


def _rebase(
    flags: dict[str, ParsedFlagValue],
    cs: CompiledSpec,
    spelling: str,
    value: str,
    base: str,
) -> str:
    """Fold one option occurrence into the operand base directory.

    Called after every value-flag record. Only the spec's declared
    ``operand_base`` option moves the base, and it moves it the way a
    chdir does: relative to wherever the previous occurrence left it, so
    ``-C d1 ... -C ../d2`` lands in ``d1/../d2``. The resolved absolute
    path replaces the raw value in the flag bag, so the later path-flag
    pass has nothing left to resolve.

    Args:
        flags (dict): parsed flag bag, updated in place.
        cs (CompiledSpec): compiled spec tables.
        spelling (str): dashed spelling as typed.
        value (str): the flag's value.
        base (str): the base directory in effect before this occurrence.

    Returns:
        str: the base directory in effect after this occurrence.
    """
    if cs.base_dest is None or cs.dest_of(spelling) != cs.base_dest:
        return base
    moved = resolve_path(value, base)
    bag = flags.get(cs.base_dest)
    if isinstance(bag, list) and bag:
        # An accumulating option already appended the raw value; the
        # resolved one replaces it so nothing resolves it twice.
        bag[-1] = moved
    else:
        flags[cs.base_dest] = moved
    return moved


def _set_bool_flag(
    flags: dict[str, ParsedFlagValue],
    cs: CompiledSpec,
    spelling: str,
) -> None:
    """Record a boolean flag occurrence under its canonical dest.

    A count flag accumulates occurrences into an int (``-vvv`` and
    ``-v -v -v`` both land as 3); every other boolean flag is sticky
    True.

    Args:
        flags (dict): parsed flag bag, updated in place.
        cs (CompiledSpec): compiled spec tables.
        spelling (str): dashed spelling as typed.
    """
    name = cs.dest_of(spelling)
    if name in cs.count_dests:
        prev = flags.get(name)
        flags[name] = prev + 1 if isinstance(prev, int) else 1
    else:
        flags[name] = True


def _match_mixed_cluster(
    tok: str,
    cs: CompiledSpec,
) -> tuple[list[str], str, str | None] | None:
    """Match a getopt-style cluster of bool flags ending in a value flag.

    Args:
        tok (str): token like "-ne" or "-nepat".
        cs (CompiledSpec): compiled spec tables.

    Returns:
        tuple[list[str], str, str | None] | None: (bool flag spellings,
            value flag spelling, attached value or None when the value
            comes from the next token), or None when any character is
            unknown or no value flag terminates the cluster.
    """
    bools: list[str] = []
    chars = tok[1:]
    for idx, ch in enumerate(chars):
        name = f"-{ch}"
        if name in cs.bool_spellings:
            bools.append(name)
            continue
        if name in cs.value_spellings:
            rest = chars[idx + 1:]
            return bools, name, (rest if rest else None)
        return None
    return None


def parse_command(
    spec: CommandSpec,
    argv: list[str],
    cwd: str,
) -> ParsedArgs:
    cs = compile_spec(spec)

    # tar's old option style is expanded before anything else reads the
    # line, so classification, routing and dispatch all scan the same
    # dashed words; scan_origins maps each of them back to the caller's
    # argv slot (every synthesized token to the cluster's own slot).
    old = expand_old_style(cs, argv) if spec.old_option_style else None
    scan_argv = old.argv if old is not None else argv
    scan_origins = old.origins if old is not None else list(range(len(argv)))

    cache_paths: list[str] = []
    filtered_argv: list[str] = []
    # orig_indices[j] = argv position of filtered_argv[j]
    orig_indices: list[int] = []
    i = 0
    while i < len(scan_argv):
        if scan_argv[i] == "--cache":
            i += 1
            while i < len(scan_argv) and not scan_argv[i].startswith("-"):
                cache_paths.append(resolve_path(scan_argv[i], cwd))
                i += 1
        else:
            filtered_argv.append(scan_argv[i])
            orig_indices.append(scan_origins[i])
            i += 1

    flags: dict[str, ParsedFlagValue] = {}
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
    word_kinds: list[ValueType | None] = [None] * len(argv)
    if old is not None and old.cluster is not None:
        # A cluster carries no dash, so leaving it None would send it to
        # the shape heuristic and a path-shaped one (`tar sub/a.tgz`)
        # would reach dispatch resolved and unreadable as letters.
        word_kinds[0] = "str"
    # The directory the next path operand resolves against, and where it
    # was for each word already read. It only ever moves for a spec that
    # declares operand_base, so every other command records None
    # throughout and the classifier keeps using the session cwd.
    base = cwd
    word_bases: list[str | None] = [None] * len(argv)
    raw_bases: list[str] = []
    warnings: list[str] = []
    invalid_options: list[str] = []
    ambiguous_options: list[tuple[str, tuple[str, ...]]] = []
    option_error_kinds: list[str] = []
    needs_value_options: list[str] = []
    # Free-text commands (echo/python/bash-style TEXT rest) keep unknown
    # dash tokens verbatim; elsewhere they are dropped with a warning so a
    # stray flag never corrupts pattern/path classification.
    lenient_dash_operands = (cs.rest_kind is not None
                             and cs.rest_kind != "path")
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
            raw_bases.append(base)
            i += 1
            continue

        if tok.startswith("--"):
            # getopt_long: an exact spelling always wins; otherwise an
            # unambiguous prefix expands to its declared spelling
            # (grep --rec) and an ambiguous one is refused with every
            # possibility. Free-text commands keep exact-only matching:
            # their unknown dash tokens are operands, not typos.
            eq = tok.find("=")
            typed = tok if eq == -1 else tok[:eq]
            spelling = typed
            if typed not in cs.dest and not lenient_dash_operands:
                expansions = expand_long(cs, typed)
                if len(expansions) == 1:
                    spelling = expansions[0]
                elif len(expansions) > 1:
                    ambiguous_options.append((typed, expansions))
                    option_error_kinds.append("ambiguous")
                    i += 1
                    continue
            etok = spelling if eq == -1 else spelling + tok[eq:]
            is_pair = cs.dest_of(spelling) in cs.pair_dests
            if etok in cs.long_bool_spellings:
                _set_bool_flag(flags, cs, etok)
                i += 1
            elif is_pair and eq == -1 and i + 2 < len(filtered_argv):
                # Two tokens, both recorded under the one dest, so the
                # command reads the accumulated list in twos.
                _set_value_flag(flags, cs, spelling, filtered_argv[i + 1])
                _set_value_flag(flags, cs, spelling, filtered_argv[i + 2])
                # The first token names the value and is always textual;
                # the option's own kind describes the second.
                word_kinds[orig_indices[i + 1]] = "str"
                word_kinds[orig_indices[i + 2]] = cs.kind_of[spelling]
                i += 3
            elif (not is_pair and etok in cs.long_value_spellings
                  and i + 1 < len(filtered_argv)):
                _set_value_flag(flags, cs, etok, filtered_argv[i + 1])
                word_kinds[orig_indices[i + 1]] = cs.kind_of[etok]
                if cs.dest_of(etok) == cs.base_dest:
                    word_bases[orig_indices[i + 1]] = base
                base = _rebase(flags, cs, etok, filtered_argv[i + 1], base)
                i += 2
            elif is_pair:
                if eq == -1:
                    needs_value_options.append(spelling)
                else:
                    # A two-token option has no `=` form (jq refuses
                    # `--arg=name` as an unknown option).
                    invalid_options.append(tok)
                    option_error_kinds.append("invalid")
                i += 1
            else:
                if eq != -1 and (spelling in cs.long_value_spellings
                                 or spelling in cs.long_optional_spellings):
                    _set_value_flag(flags, cs, spelling, tok[eq + 1:])
                    base = _rebase(flags, cs, spelling, tok[eq + 1:], base)
                elif etok in cs.long_value_spellings:
                    # Declared value flag at end of line with no argument.
                    needs_value_options.append(etok)
                elif lenient_dash_operands:
                    raw_args.append(tok)
                    raw_indices.append(orig_indices[i])
                    raw_bases.append(base)
                else:
                    invalid_options.append(tok)
                    option_error_kinds.append("invalid")
                i += 1
            continue

        if tok.startswith("-") and len(tok) > 1:
            if cs.numeric_dest is not None and NUMERIC_SHORT.match(tok):
                flags[cs.numeric_dest] = tok[1:]
                i += 1
                continue
            matched_optional = False
            for vf in cs.attach_spellings:
                if tok.startswith(vf) and len(tok) > len(vf):
                    _set_value_flag(flags, cs, vf, tok[len(vf):])
                    base = _rebase(flags, cs, vf, tok[len(vf):], base)
                    i += 1
                    matched_optional = True
                    break
            if matched_optional:
                continue
            matched_value = False
            for vf in cs.value_spellings:
                if tok == vf and i + 1 < len(filtered_argv):
                    _set_value_flag(flags, cs, vf, filtered_argv[i + 1])
                    word_kinds[orig_indices[i + 1]] = cs.kind_of[vf]
                    if cs.dest_of(vf) == cs.base_dest:
                        word_bases[orig_indices[i + 1]] = base
                    base = _rebase(flags, cs, vf, filtered_argv[i + 1], base)
                    i += 2
                    matched_value = True
                    break
                if tok.startswith(vf) and len(tok) > len(vf):
                    _set_value_flag(flags, cs, vf, tok[len(vf):])
                    base = _rebase(flags, cs, vf, tok[len(vf):], base)
                    i += 1
                    matched_value = True
                    break
            if matched_value:
                continue

            if tok in cs.bool_spellings:
                _set_bool_flag(flags, cs, tok)
                i += 1
                continue

            all_bool = True
            for ch in tok[1:]:
                if f"-{ch}" not in cs.bool_spellings:
                    all_bool = False
                    break
            if all_bool and len(tok) > 1:
                for ch in tok[1:]:
                    _set_bool_flag(flags, cs, f"-{ch}")
                i += 1
                continue

            mixed = _match_mixed_cluster(tok, cs)
            if mixed is not None:
                cluster_bools, vflag, attached = mixed
                if attached is not None:
                    for name in cluster_bools:
                        _set_bool_flag(flags, cs, name)
                    _set_value_flag(flags, cs, vflag, attached)
                    base = _rebase(flags, cs, vflag, attached, base)
                    i += 1
                    continue
                if i + 1 < len(filtered_argv):
                    for name in cluster_bools:
                        _set_bool_flag(flags, cs, name)
                    _set_value_flag(flags, cs, vflag, filtered_argv[i + 1])
                    word_kinds[orig_indices[i + 1]] = cs.kind_of[vflag]
                    if cs.dest_of(vflag) == cs.base_dest:
                        word_bases[orig_indices[i + 1]] = base
                    base = _rebase(flags, cs, vflag, filtered_argv[i + 1],
                                   base)
                    i += 2
                    continue

            if lenient_dash_operands or NUMERIC_SHORT.match(tok):
                raw_args.append(tok)
                raw_indices.append(orig_indices[i])
                raw_bases.append(base)
            elif tok in cs.value_spellings or (mixed is not None
                                               and mixed[2] is None):
                # A declared value flag (alone or ending a cluster) with no
                # argument left on the line. GNU reports the flag character.
                if tok in cs.value_spellings:
                    needy = tok[1:]
                else:
                    assert mixed is not None
                    needy = mixed[1][1:]
                needs_value_options.append(needy)
            else:
                # GNU reports the first offending character, not the token.
                bad = tok[1:2]
                for ch in tok[1:]:
                    if (f"-{ch}" not in cs.bool_spellings
                            and f"-{ch}" not in cs.value_spellings):
                        bad = ch
                        break
                invalid_options.append(bad)
                option_error_kinds.append("invalid")
            i += 1
            continue

        raw_args.append(tok)
        raw_indices.append(orig_indices[i])
        raw_bases.append(base)
        i += 1

    # Declared defaults land as if typed, before choices/required checks
    # and before PATH/TEXT flag-value collection, so a PATH default
    # resolves and routes and a default always satisfies required. A
    # multiple dest holds lists, so its default is a one-element list.
    for dest_name, default in cs.defaults.items():
        if dest_name not in flags:
            if dest_name in cs.multiple_dests:
                flags[dest_name] = [default]
            else:
                flags[dest_name] = default

    # Int-typed values are refused before choices, argparse's order
    # (type conversion runs before the choices test). The bare boolean
    # form of an optional-value flag is exempt, like choices.
    invalid_int_options: list[tuple[str, str]] = []
    for dest_name in cs.int_dests:
        value = flags.get(dest_name)
        candidates = value if isinstance(
            value, list) else ([value] if isinstance(value, str) else [])
        for part in candidates:
            if not INT_VALUE.match(part):
                invalid_int_options.append((dest_name, part))
    invalid_float_options: list[tuple[str, str]] = []
    for dest_name in cs.float_dests:
        value = flags.get(dest_name)
        candidates = value if isinstance(
            value, list) else ([value] if isinstance(value, str) else [])
        for part in candidates:
            if not FLOAT_VALUE.match(part):
                invalid_float_options.append((dest_name, part))

    invalid_value_options: list[tuple[str, str, tuple[str, ...]]] = []
    for dest_name, allowed in cs.choices_by_dest.items():
        value = flags.get(dest_name)
        # The bare boolean form of an optional-value flag is exempt.
        candidates = value if isinstance(
            value, list) else ([value] if isinstance(value, str) else [])
        for part in candidates:
            if part not in allowed:
                invalid_value_options.append((dest_name, part, allowed))

    missing_required_options = [
        dest_name for dest_name in cs.required_dests if dest_name not in flags
    ]

    positional: tuple[ValueType, ...] = tuple(
        op.type for op in spec.positional
        if not any(cs.dest_of(name) in flags for name in op.provided_by))

    # A flag can turn the rest slot textual for this line only (jq's
    # --args makes every later operand a positional string rather than an
    # input file). Only classification moves: unknown dash tokens stay as
    # strict as the declared kind makes them.
    rest_kind = cs.rest_kind
    if spec.rest is not None and any(
            cs.dest_of(name) in flags for name in spec.rest.text_when):
        rest_kind = "str"

    # Overflow operands past the declared positional slots pass through
    # classified like the last slot (TEXT when there is none), so a
    # fixed-arity command receives them and raises its own extra-operand
    # UsageError (#452). The parser classifies, it never drops or raises.
    overflow_kind = positional[-1] if positional else "str"

    classified: list[tuple[str, ValueType]] = []
    raw_operands: list[tuple[str, ValueType]] = []
    for j, arg in enumerate(raw_args):
        kind: ValueType
        if arg in spec.ignore_tokens:
            # Expression syntax, never an operand of the declared kind:
            # `find /d \( -name x \)` would otherwise classify "(" and
            # ")" as PATH operands, giving find two phantom start points
            # (`/(`, `/)`) on top of the real one.
            kind = "str"
        elif j < len(positional):
            kind = positional[j]
        elif rest_kind is not None:
            kind = rest_kind
        else:
            kind = overflow_kind
        if kind == "path":
            # Against the base an operand_base option left in effect at
            # this position, which is the session cwd for every command
            # that declares none.
            classified.append((resolve_path(arg, raw_bases[j]), "path"))
            raw_operands.append((arg, "path"))
            if raw_bases[j] != cwd:
                word_bases[raw_indices[j]] = raw_bases[j]
        else:
            classified.append((arg, kind))
            raw_operands.append((arg, kind))
        word_kinds[raw_indices[j]] = kind

    path_flag_values: list[str] = []
    for flag_name, kind in cs.kind_by_dest.items():
        if kind != "path" or flag_name not in flags:
            continue
        value = flags[flag_name]
        if isinstance(value, list) and flag_name in cs.pair_dests:
            # Only the odd slots are the paths: the even ones name them.
            paired = [
                resolve_path(part, cwd) if index % 2 else part
                for index, part in enumerate(value)
            ]
            flags[flag_name] = paired
            path_flag_values.extend(paired[1::2])
        elif isinstance(value, list):
            resolved_list = [resolve_path(part, cwd) for part in value]
            flags[flag_name] = resolved_list
            path_flag_values.extend(resolved_list)
        elif isinstance(value, str):
            resolved = resolve_path(value, cwd)
            flags[flag_name] = resolved
            path_flag_values.append(resolved)

    text_flag_values: list[str] = []
    for flag_name, kind in cs.kind_by_dest.items():
        if kind == "path" or flag_name not in flags:
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
        word_bases=word_bases,
        invalid_options=invalid_options,
        ambiguous_options=ambiguous_options,
        option_error_kinds=option_error_kinds,
        needs_value_options=needs_value_options,
        invalid_value_options=invalid_value_options,
        invalid_int_options=invalid_int_options,
        invalid_float_options=invalid_float_options,
        missing_required_options=missing_required_options,
        old_option_needs_value=old.needs_value if old is not None else None,
    )


def parse_to_kwargs(parsed: ParsedArgs) -> dict[str, ParsedFlagValue]:
    result: dict[str, ParsedFlagValue] = {}
    for key, value in parsed.flags.items():
        result[flag_kwarg_name(key)] = value
    return result
