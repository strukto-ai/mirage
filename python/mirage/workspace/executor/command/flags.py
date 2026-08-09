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

from mirage.commands.spec import (CommandSpec, flag_kwarg_name, parse_command,
                                  parse_to_kwargs)
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import (  # yapf: disable
    ambiguous_option_error, invalid_argument_error, invalid_float_error,
    invalid_int_error, missing_required_error, missing_value_error,
    old_option_error, unknown_option_error)
from mirage.types import PathSpec
from mirage.workspace.executor.command.types import ParsedCommand


def synthesize_path_spec(value: str) -> PathSpec:
    """A PathSpec for a path the classifier never saw.

    Covers a relative value cwd-resolved by ``parse_command`` (e.g.
    ``csplit -f part`` -> ``/data/part``) and a spec-classified PATH
    operand the upstream classifier left as text. ``resource_path``
    stays empty on purpose: the mount stamps the backend key on every
    positional path and path-shaped flag value at execute time
    (``Mount.execute_cmd``), so a parse-time stamp is dead weight —
    proven by running the full suite with this field set to a
    sentinel.

    Args:
        value (str): the resolved absolute virtual path.
    """
    return PathSpec(virtual=value,
                    directory=value[:value.rfind("/") + 1] or "/",
                    resource_path="",
                    resolved=True)


def parse_flags(
    parts: list[str | PathSpec],
    spec: CommandSpec | None,
    cmd_name: str,
    cwd: str,
    str_flag_paths: bool = False,
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
        str_flag_paths (bool): keep PATH flag values as their resolved
            virtual-path strings instead of PathSpec. Cross-mount
            strategies read flags through FlagView, which type-checks
            str, so they get the string view.

    Returns:
        ParsedCommand: positional paths, positional texts, parsed flag dict
        (PATH flag values recovered to PathSpec, multiple PATH flags to
        list[PathSpec]), and parser warnings (e.g. ignored unknown options).
    """
    # Build string argv and PathSpec lookup
    argv = [
        item.virtual if isinstance(item, PathSpec) else item for item in parts
    ]
    scope_map: dict[str, PathSpec] = {}
    for item in parts:
        if isinstance(item, PathSpec):
            scope_map[item.virtual] = item
            stripped = item.virtual.rstrip("/")
            if stripped and stripped != item.virtual:
                scope_map[stripped] = item

    if spec is not None:
        parsed = parse_command(spec, argv, cwd=cwd)
        # Widens from ParsedFlagValue to FlagValue: PATH values
        # become PathSpec just below.
        flag_kwargs: dict[str, FlagValue] = dict(parse_to_kwargs(parsed))

        # Recover PathSpec for PATH flag values; multiple PATH flags
        # arrive as a list of resolved paths and become list[PathSpec].
        # A relative PATH flag value cwd-resolved by parse_command (e.g.
        # csplit -f part -> /data/part) is absent from scope_map, so build a
        # PathSpec for it just like positional paths do, otherwise it never
        # gets the mount prefix stripped.
        repeat_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options if opt.type == "path" and opt.multiple
            for name in (opt.short, opt.long) if name
        }
        # A pair option's list alternates name, value; only the values
        # are paths (jq --rawfile body /d/f.txt).
        pair_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options if opt.type == "path" and opt.pair
            for name in (opt.short, opt.long) if name
        }
        single_path_keys = {
            flag_kwarg_name(name)
            for opt in spec.options if opt.type == "path" and not opt.multiple
            for name in (opt.short, opt.long) if name
        }
        if not str_flag_paths:
            for key, value in flag_kwargs.items():
                # Only the parser's own list[str] values reach here; a
                # PathSpec list is already promoted.
                texts_in: list[str] = ([
                    item for item in value if isinstance(item, str)
                ] if isinstance(value, list) else [])
                if key in pair_path_keys and isinstance(value, list):
                    # A pair is (name, value): only the odd slots are paths.
                    flag_kwargs[key] = [
                        scope_map.get(part, synthesize_path_spec(part))
                        if index % 2 else part
                        for index, part in enumerate(texts_in)
                    ]
                elif key in repeat_path_keys and isinstance(value, list):
                    flag_kwargs[key] = [
                        scope_map.get(part, synthesize_path_spec(part))
                        for part in texts_in
                    ]
                elif key in single_path_keys and isinstance(value, str):
                    flag_kwargs[key] = scope_map.get(
                        value, synthesize_path_spec(value))
                elif isinstance(value, str) and value in scope_map:
                    flag_kwargs[key] = scope_map[value]

        # Classify positional args
        paths: list[PathSpec] = []
        texts: list[str] = []
        for value, kind in parsed.args:
            if kind == "path":
                scope = scope_map.get(value)
                if scope is None:
                    scope = synthesize_path_spec(value)
                paths.append(scope)
            else:
                texts.append(value)
        return ParsedCommand(
            paths, texts, flag_kwargs, parsed.warnings, parsed.invalid_options,
            parsed.ambiguous_options, parsed.option_error_kinds,
            parsed.needs_value_options, parsed.invalid_value_options,
            parsed.invalid_int_options, parsed.invalid_float_options,
            parsed.missing_required_options, parsed.old_option_needs_value)

    # No spec: separate by type
    paths = [item for item in parts if isinstance(item, PathSpec)]
    texts = [item for item in parts if not isinstance(item, PathSpec)]
    return ParsedCommand(paths, texts, {}, [], [], [], [], [], [], [], [], [])


def option_error(cmd_name: str,
                 parsed: ParsedCommand) -> tuple[bytes, int] | None:
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
    # Scan-order between unknown and ambiguous options: GNU stops at the
    # first offending token, so `grep --c --bogus` reports the ambiguity
    # and the reversed line reports --bogus.
    if (parsed.option_error_kinds
            and parsed.option_error_kinds[0] == "ambiguous"):
        token, candidates = parsed.ambiguous_options[0]
        return ambiguous_option_error(cmd_name, token, candidates)
    if parsed.invalid_options:
        return unknown_option_error(cmd_name, parsed.invalid_options[0])
    if parsed.ambiguous_options:
        token, candidates = parsed.ambiguous_options[0]
        return ambiguous_option_error(cmd_name, token, candidates)
    if parsed.needs_value_options:
        return missing_value_error(cmd_name, parsed.needs_value_options[0])
    # Numeric-typed values before choices, argparse's order (choices are
    # checked against the converted value), matching the walk's
    # _finish_node: a non-numeric value on an int/float option that also
    # declares choices reports the conversion failure, not the choice list.
    if parsed.invalid_int_options:
        option, value = parsed.invalid_int_options[0]
        return invalid_int_error(cmd_name, option, value)
    if parsed.invalid_float_options:
        option, value = parsed.invalid_float_options[0]
        return invalid_float_error(cmd_name, option, value)
    if parsed.invalid_value_options:
        option, value, choices = parsed.invalid_value_options[0]
        return invalid_argument_error(cmd_name, option, value, choices)
    if parsed.missing_required_options:
        return missing_required_error(cmd_name,
                                      parsed.missing_required_options[0])
    return None
