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

from collections import defaultdict, deque
from collections.abc import Mapping, Sequence

from mirage.commands.spec import (
    CommandSpec,
    flag_kwarg_name,
    parse_command,
    parse_to_kwargs,
)
from mirage.commands.spec.flag_view import FlagBag
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import (
    ambiguous_option_error,
    invalid_argument_error,
    invalid_float_error,
    invalid_int_error,
    missing_required_error,
    missing_value_error,
    old_option_error,
    unexpected_value_error,
    unknown_option_error,
)
from mirage.types import PathSpec
from mirage.utils.path import dotted_spelling, resolve_path
from mirage.workspace.executor.command.types import ParsedCommand


def synthesize_path_spec(
    value: str, raw_path: str | None = None, cwd: str = "/"
) -> PathSpec:
    """A PathSpec for a path the classifier never saw.

    Covers a relative value cwd-resolved by ``parse_command`` (e.g.
    ``csplit -f part`` -> ``/data/part``) and a spec-classified PATH
    operand the upstream classifier left as text. ``vfs_path``
    stays empty on purpose: the mount stamps the backend key on every
    positional path and path-shaped flag value at execute time
    (``Mount.execute_cmd``), so a parse-time stamp is dead weight —
    proven by running the full suite with this field set to a
    sentinel. The empty name, which only an attached value can spell
    (``--file=``), names nothing, however it resolved: its walk answers
    ENOENT, as a typed ``''`` operand's does.

    Args:
        value (str): the resolved absolute virtual path.
        raw_path (str | None): the value before parser path resolution.
        cwd (str): working directory for the retained dotted spelling.
    """
    return PathSpec(
        virtual=value,
        raw_path=raw_path,
        directory=value[: value.rfind("/") + 1] or "/",
        vfs_path="",
        resolved=True,
        dotted=dotted_spelling(raw_path, cwd)
        if raw_path is not None and resolve_path(raw_path, cwd) == value
        else None,
        walk_error="ENOENT" if raw_path == "" else None,
    )


def take_spelling(
    spellings: dict[str, deque[PathSpec]],
    scope_map: Mapping[str, PathSpec],
    value: str,
    raw_path: str | None = None,
    cwd: str = "/",
) -> PathSpec:
    """The next classified word spelling ``value``, in argv order.

    Two words can resolve to one path (`ls -d dir/ link/` with link ->
    dir, `tar -C dir .`), each with its own spelling, so every consumer
    takes the next word for its path off a queue rather than reading a
    lookup keyed by the path alone, which handed them all the last
    spelling; the parser hands positionals back in argv order, the
    guarantee argparse gives too. A path no word spells (one the parser
    normalized, a followed link whose target climbs through `..`) falls
    back to the map, which still serves a word the classifier left as
    text, and is synthesized after that, since a keyed backend cannot
    read `b/../a`.

    Args:
        spellings (dict[str, deque[PathSpec]]): the classified words by
            resolved path, in argv order; the word taken is removed.
        scope_map (Mapping[str, PathSpec]): the classified words by path,
            last spelling wins.
        value (str): the resolved path the parser reported.
        raw_path (str | None): spelling retained by the parser.
        cwd (str): working directory for synthesized path spellings.
    """
    queue = spellings.get(value.rstrip("/") or "/")
    if queue:
        return queue.popleft()
    return scope_map.get(value) or synthesize_path_spec(value, raw_path, cwd)


def parse_flags(
    parts: list[str | PathSpec],
    spec: CommandSpec | None,
    cmd_name: str,
    cwd: str,
    env: Mapping[str, str] | None = None,
    *,
    unknown_is_operand: bool = False,
    abbreviations: Sequence[str] | None = None,
) -> ParsedCommand:
    """Parse flags from classified parts, recovering PathSpec for PATH values.

    Single-mount dispatch and cross-mount dispatch both parse through
    here, so flags, texts, and parser warnings cannot drift between the
    two paths (a cross-mount `grep --bogus` used to lose its warning).

    Args:
        parts (list[str | PathSpec]): expanded command words after the
            command name; path-classified words arrive as PathSpec.
        spec (CommandSpec | None): command spec, from the owning mount on
            the single-mount path or the shared SPECS registry on the
            cross-mount path; None falls back to type separation.
        cmd_name (str): command name used in warnings.
        cwd (str): current working directory for relative path resolution.
        env (Mapping[str, str] | None): the session environment, so an
            option declaring one gets its value from there. Filled
            inside the parse rather than after it, or an env-supplied
            int would go unchecked and an env-supplied path would stay
            a bare string.
        unknown_is_operand (bool): whether another parser reads this
            line after mirage, passed straight to parse_command. True
            only for an installed CLI's node, whose spec is deliberately
            partial.
        abbreviations (Sequence[str] | None): the program's own
            long-option table, when it resolves abbreviations against it
            (git's parse-options), passed straight to parse_command.

    Returns:
        ParsedCommand: positional paths, positional texts, parsed flag dict
        (PATH flag values recovered to PathSpec, multiple PATH flags to
        list[PathSpec]), and parser warnings (e.g. ignored unknown options).
    """
    # Build string argv and PathSpec lookup
    argv = [
        ("-" if item.raw_path == "-" else item.virtual)
        if isinstance(item, PathSpec)
        else item
        for item in parts
    ]
    scope_map: dict[str, PathSpec] = {}
    for item in parts:
        if isinstance(item, PathSpec):
            scope_map[item.virtual] = item
            stripped = item.virtual.rstrip("/")
            if stripped and stripped != item.virtual:
                scope_map[stripped] = item
    spellings: dict[str, deque[PathSpec]] = defaultdict(deque)
    for item in parts:
        if isinstance(item, PathSpec):
            spellings[item.virtual.rstrip("/") or "/"].append(item)

    if spec is not None:
        parsed = parse_command(
            spec,
            argv,
            cwd=cwd,
            cmd_name=cmd_name,
            env=env,
            unknown_is_operand=unknown_is_operand,
            abbreviations=abbreviations,
        )
        # Widens from ParsedFlagValue to FlagValue: PATH values
        # become PathSpec just below.
        flag_kwargs: dict[str, FlagValue] = FlagBag(parse_to_kwargs(parsed))

        # Recover PathSpec for PATH flag values; multiple PATH flags
        # arrive as a list of resolved paths and become list[PathSpec].
        # A relative PATH flag value cwd-resolved by parse_command (e.g.
        # csplit -f part -> /data/part) is absent from scope_map, so build a
        # PathSpec for it just like positional paths do, otherwise it never
        # gets the mount prefix stripped.
        repeat_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.type == "path" and opt.multiple
            for name in (opt.short, opt.long)
            if name
        }
        # A pair option's list alternates name, value; only the values
        # are paths (jq --rawfile body /d/f.txt).
        pair_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.type == "path" and opt.pair
            for name in (opt.short, opt.long)
            if name
        }
        single_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options
            if opt.type == "path" and not opt.multiple
            for name in (opt.short, opt.long)
            if name
        }
        # An option's value is read before the operands, which is POSIX
        # order and the order -C requires (its value moves the operands
        # after it), so `tar -cf out.tar -C dir .` hands `dir` to -C and
        # `.` to the operand. A permuted line spelling one path twice,
        # once as an option's value typed after the operand, swaps the
        # two spellings and nothing else.
        for key, value in flag_kwargs.items():
            raw = parsed.raw_path_flags.get(key)
            raw_parts = raw if isinstance(raw, list) else []
            # Only the parser's own list[str] values reach here; a
            # PathSpec list is already promoted.
            texts_in: list[str] = (
                [item for item in value if isinstance(item, str)]
                if isinstance(value, list)
                else []
            )
            if key in pair_path_keys and isinstance(value, list):
                # A pair is (name, value): only the odd slots are paths.
                pairs: list[str | PathSpec] = list(texts_in)
                for index in range(1, len(pairs), 2):
                    pairs[index] = take_spelling(
                        spellings,
                        scope_map,
                        texts_in[index],
                        raw_parts[index],
                        cwd,
                    )
                flag_kwargs[key] = pairs
            elif key in repeat_path_keys and isinstance(value, list):
                flag_kwargs[key] = [
                    take_spelling(
                        spellings, scope_map, part, raw_parts[index], cwd
                    )
                    for index, part in enumerate(texts_in)
                ]
            elif key in single_path_keys and isinstance(value, str):
                flag_kwargs[key] = take_spelling(
                    spellings,
                    scope_map,
                    value,
                    raw if isinstance(raw, str) else None,
                    cwd,
                )
            elif isinstance(value, str) and value in scope_map:
                flag_kwargs[key] = scope_map[value].virtual

        # Classify positional args: each operand takes its own word. The
        # spelling rides along for a word the classifier left as text
        # (an interpreter's bare script name under the shell's word
        # policy), so the handler still sees it as typed: CPython puts
        # the operand itself in argv[0].
        paths: list[PathSpec] = []
        texts: list[str] = []
        for (value, kind), (raw, _) in zip(parsed.args, parsed.raw_operands):
            if kind == "path":
                paths.append(
                    take_spelling(spellings, scope_map, value, raw, cwd)
                )
            else:
                texts.append(value)
        return ParsedCommand(
            paths,
            texts,
            flag_kwargs,
            parsed.warnings,
            parsed.invalid_options,
            parsed.ambiguous_options,
            parsed.option_error_kinds,
            parsed.needs_value_options,
            parsed.invalid_value_options,
            parsed.ambiguous_value_options,
            parsed.invalid_int_options,
            parsed.invalid_float_options,
            parsed.missing_required_options,
            parsed.old_option_needs_value,
            parsed.missing_required_operands,
            parsed.typed_dests,
        )

    # No spec: separate by type
    paths = [item for item in parts if isinstance(item, PathSpec)]
    texts = [item for item in parts if not isinstance(item, PathSpec)]
    return ParsedCommand(
        paths, texts, {}, [], [], [], [], [], [], [], [], [], []
    )


def option_error(
    cmd_name: str, parsed: ParsedCommand
) -> tuple[bytes, int] | None:
    """GNU-shaped refusal for option errors the parser reported.

    find is exempt: its expression tokens are validated by
    parse_find_expression, which raises the GNU predicate error itself.

    Args:
        cmd_name (str): command name for message shape and exit code.
        parsed (ParsedCommand): parse result carrying the reports.
    """
    if cmd_name == "find":
        return None
    # An old-style cluster short of an argument outranks every scan error
    # below: tar counts the cluster's needs before argp validates a
    # letter, so `tar Qf` and `tar fQ` both name f, not Q.
    if parsed.old_option_needs_value is not None:
        return old_option_error(cmd_name, parsed.old_option_needs_value)
    # The first refusal on the line, whichever check made it: GNU stops
    # at the first offending token, so `grep --c --bogus` reports the
    # ambiguity, the reversed line reports --bogus, and `numfmt
    # --from=bad --bogus` reports the value. The kinds tape holds one tag
    # per refusal in scan order and each list is in scan order too, so
    # the first tag's detail is the head of that tag's list. "invalid"
    # and "unexpected_value" share invalid_options: a boolean long handed
    # a value is not an unrecognized option, and getopt_long words it
    # differently (`grep --byte-offset=2`).
    for kind in parsed.option_error_kinds:
        if kind == "ambiguous":
            token, candidates = parsed.ambiguous_options[0]
            return ambiguous_option_error(cmd_name, token, candidates)
        if kind == "unexpected_value":
            return unexpected_value_error(cmd_name, parsed.invalid_options[0])
        if kind == "invalid":
            return unknown_option_error(cmd_name, parsed.invalid_options[0])
        if kind == "needs_value":
            return missing_value_error(cmd_name, parsed.needs_value_options[0])
        if kind == "int":
            option, value = parsed.invalid_int_options[0]
            return invalid_int_error(cmd_name, option, value)
        if kind == "float":
            option, value = parsed.invalid_float_options[0]
            return invalid_float_error(cmd_name, option, value)
        if kind == "value":
            option, value, choices = parsed.invalid_value_options[0]
            return invalid_argument_error(cmd_name, option, value, choices)
        # gnulib's other wording for the same refusal, reached only by an
        # ARGMATCH table: the value is a prefix of two candidates or more.
        if kind == "ambiguous_value":
            option, value, choices = parsed.ambiguous_value_options[0]
            return invalid_argument_error(
                cmd_name, option, value, choices, kind="ambiguous"
            )
    if parsed.missing_required_options:
        return missing_required_error(
            cmd_name, parsed.missing_required_options[0]
        )
    return None
