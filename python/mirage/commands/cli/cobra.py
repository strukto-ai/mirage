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


# Follows gh 2.85.0's root usage function and error printing (MIT; see
# licenses/third_party/gh.txt), Cobra 1.10.2's unknown-command suggestions
# (Apache-2.0; licenses/third_party/cobra.txt) and pflag 1.0.10's option table
# and refusals (BSD-3-Clause; licenses/third_party/pflag.txt).

from collections.abc import Sequence
from typing import TYPE_CHECKING

from mirage.commands.spec.types import Argument, CommandSpec

if TYPE_CHECKING:
    from mirage.commands.spec.parser import ParsedArgs
    from mirage.workspace.executor.command.types import ParsedCommand

COBRA_EXIT = 1
SUGGESTION_DISTANCE = 2
UNKNOWN_OPTION = "unknown option: "
NEEDS_VALUE_HEAD = "error: option '"
NEEDS_VALUE_TAIL = "' requires a value"
DEPRECATED = "Deprecated:"
GIT_FLAGS_HINT = {
    "gist clone": "Separate git clone flags with '--'.",
    "repo clone": "Separate git clone flags with '--'.",
    "repo fork": "Separate git clone flags with `--`.",
}
NO_FLAGS_IN_USE = frozenset(
    ("gist clone", "release create", "release edit", "repo clone")
)


def _long_name(argument: Argument) -> str:
    """The option's long spelling, or "" when it has none.

    Args:
        argument (Argument): the option.
    """
    return next((n for n in argument.names if n.startswith("--")), "")


def _short_name(argument: Argument) -> str:
    """The option's short spelling, or "" when it has none.

    Args:
        argument (Argument): the option.
    """
    return next(
        (
            n
            for n in argument.names
            if n.startswith("-") and not n.startswith("--")
        ),
        "",
    )


def _is_switch(argument: Argument) -> bool:
    """Whether the option is one of pflag's booleans.

    Args:
        argument (Argument): the option.
    """
    return argument.action == "store_true" or (
        argument.nargs == "?" and argument.attached_only
    )


def _is_inherited(argument: Argument) -> bool:
    """Whether Cobra lists the option apart from the command's own.

    gh adds ``-R`` to a whole group as a persistent flag, which a
    command's usage leaves out, and Mirage declares it on each leaf. A
    command that declares ``-R`` itself names its value.

    Args:
        argument (Argument): the option.
    """
    return argument.names == ("-R", "--repo") and argument.metavar is None


def _value_name(argument: Argument) -> str:
    """The word after the option in its row, as pflag's UnquoteUsage has it.

    Args:
        argument (Argument): the option.
    """
    if argument.metavar is not None:
        return argument.metavar
    if _is_switch(argument):
        return ""
    if argument.type == "int":
        return "int"
    return "strings" if argument.action == "append" else "string"


def _flag_label(argument: Argument) -> str:
    """The option as pflag names it in a value refusal.

    Args:
        argument (Argument): the option.
    """
    short = _short_name(argument)
    long = _long_name(argument)
    return f"{short}, {long}" if short else long


def _usage_text(argument: Argument) -> str:
    """The option's description, with its choices and default.

    Args:
        argument (Argument): the option.
    """
    text = argument.help or ""
    if argument.choices and not _is_switch(argument) and "{" not in text:
        text = f"{text}: {{{'|'.join(argument.choices)}}}"
    if argument.default is not None:
        shown = (
            argument.default
            if argument.type == "int"
            else f'"{argument.default}"'
        )
        text = f"{text} (default {shown})"
    return text


def _flag_usages(node: CommandSpec) -> str:
    """The node's option table, as pflag aligns and gh indents it.

    Args:
        node (CommandSpec): the leaf.
    """
    options = sorted(
        (
            argument
            for argument in node.arguments
            if _long_name(argument)
            and not _is_inherited(argument)
            and not (argument.help or "").startswith(DEPRECATED)
        ),
        key=_long_name,
    )
    if not options:
        return ""
    leads: list[str] = []
    for argument in options:
        short = _short_name(argument)
        lead = (
            f"  {short}, {_long_name(argument)}"
            if short
            else f"      {_long_name(argument)}"
        )
        value = _value_name(argument)
        leads.append(f"{lead} {value}" if value else lead)
    width = max(len(lead) for lead in leads)
    lines = [
        f"{lead}{' ' * (width - len(lead) + 3)}{_usage_text(argument)}"
        for lead, argument in zip(leads, options, strict=True)
    ]
    indent = min(len(line) - len(line.lstrip(" ")) for line in lines)
    body = "".join(f"  {line[indent:]}\n" for line in lines)
    return f"{body}  "


def cobra_usage(name: str, node: CommandSpec) -> str:
    """The usage block gh prints after a refusal.

    Args:
        name (str): the command's display path, e.g. "gh pr list".
        node (CommandSpec): the leaf or group.
    """
    if node.subcommands:
        slot = "<command> <subcommand>" if " " not in name else "<command>"
        children = sorted(child.name for child in node.subcommands)
        rows = "".join(f"  {child}\n" for child in children)
        return (
            f"Usage:  {name} {slot} [flags]\n\nAvailable commands:\n{rows}\n"
        )
    words = [
        argument.metavar or argument.names[0]
        for argument in node.arguments
        if not argument.names[0].startswith("-")
    ]
    use = " ".join((name, *words))
    if name.partition(" ")[2] not in NO_FLAGS_IN_USE:
        use = f"{use} [flags]"
    flags = _flag_usages(node)
    return (
        f"Usage:  {use}\n\nFlags:\n{flags}\n" if flags else f"Usage:  {use}\n"
    )


def cobra_refusal(message: str, name: str, node: CommandSpec) -> str:
    """A flag error as gh prints it: the message, then the usage block.

    Args:
        message (str): the error.
        name (str): the command's display path.
        node (CommandSpec): the leaf or group refusing.
    """
    gap = "\n" if message.endswith("\n") else "\n\n"
    return f"{message}{gap}{cobra_usage(name, node)}"


def sets_value_flag(node: CommandSpec, argv: Sequence[str]) -> bool:
    """Whether the line set an option that takes a value.

    Args:
        node (CommandSpec): the leaf.
        argv (Sequence[str]): the leaf's words.
    """
    spellings = {
        name
        for argument in node.arguments
        if not _is_switch(argument)
        for name in argument.names
        if name.startswith("-")
    }
    for word in argv:
        if word == "--":
            return False
        if word.startswith("-") and (
            word.partition("=")[0] in spellings or word[:2] in spellings
        ):
            return True
    return False


def _quoted(value: str) -> str:
    """The value as Go's %q prints the strings a command line carries.

    Args:
        value (str): the value.
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _shorthand_tail(letter: str, argv: Sequence[str]) -> str:
    """What is left of the short cluster at the refused letter.

    Args:
        letter (str): the refused letter.
        argv (Sequence[str]): the leaf's words.
    """
    for word in argv:
        if word == "--":
            break
        if word.startswith("-") and not word.startswith("--"):
            where = word.find(letter, 1)
            if where > 0:
                return word[where:]
    return letter


def _unknown_flag(token: str, argv: Sequence[str]) -> str:
    """pflag's refusal of an option no one declared.

    Args:
        token (str): ``--name``, ``--name=value``, ``-x`` or the letter.
        argv (Sequence[str]): the words the token came from.
    """
    if token.startswith("--"):
        return f"unknown flag: {token.partition('=')[0]}"
    letter = token.lstrip("-")
    return (
        f"unknown shorthand flag: '{letter}' in "
        f"-{_shorthand_tail(letter, argv)}"
    )


def _needs_value(token: str, argv: Sequence[str]) -> str:
    """pflag's refusal of an option short of its value.

    Args:
        token (str): ``--name``, ``-x`` or the letter.
        argv (Sequence[str]): the words the token came from.
    """
    if token.startswith("--"):
        return f"flag needs an argument: {token}"
    letter = token.lstrip("-")
    return (
        f"flag needs an argument: '{letter}' in "
        f"-{_shorthand_tail(letter, argv)}"
    )


def _argument_named(node: CommandSpec, spelling: str) -> Argument | None:
    """The option a spelling names.

    Args:
        node (CommandSpec): the leaf.
        spelling (str): the dashed spelling.
    """
    return next((a for a in node.arguments if spelling in a.names), None)


def _invalid_value(
    node: CommandSpec, spelling: str, value: str, reason: str
) -> str:
    """pflag's refusal of a value its option cannot take.

    Args:
        node (CommandSpec): the leaf.
        spelling (str): the dashed spelling.
        value (str): the rejected value.
        reason (str): why, in the option's type's words.
    """
    argument = _argument_named(node, spelling)
    label = _flag_label(argument) if argument is not None else spelling
    return f"invalid argument {_quoted(value)} for {_quoted(label)} flag: {reason}"


def leaf_message(
    parsed: "ParsedCommand | ParsedArgs",
    node: CommandSpec,
    argv: Sequence[str],
    path: str,
) -> str | None:
    """The first option error of a leaf's parse, as gh reports it.

    Args:
        parsed (ParsedCommand | ParsedArgs): the parse.
        node (CommandSpec): the leaf.
        argv (Sequence[str]): the leaf's words.
        path (str): the leaf's path below gh.
    """
    message = _option_message(parsed, node, argv)
    hint = GIT_FLAGS_HINT.get(path)
    return f"{message}\n{hint}" if message and hint else message


def _option_message(
    parsed: "ParsedCommand | ParsedArgs",
    node: CommandSpec,
    argv: Sequence[str],
) -> str | None:
    """The first option error of a leaf's parse, in pflag's words.

    Args:
        parsed (ParsedCommand | ParsedArgs): the parse.
        node (CommandSpec): the leaf.
        argv (Sequence[str]): the leaf's words.
    """
    if not parsed.option_error_kinds:
        return None
    kind = parsed.option_error_kinds[0]
    if kind == "invalid":
        return _unknown_flag(parsed.invalid_options[0], argv)
    if kind == "needs_value":
        return _needs_value(parsed.needs_value_options[0], argv)
    if kind == "int":
        option, value = parsed.invalid_int_options[0]
        parsing = f"parsing {_quoted(value)}: invalid syntax"
        return _invalid_value(
            node, option, value, f"strconv.ParseInt: {parsing}"
        )
    if kind == "value":
        option, value, _ = parsed.invalid_value_options[0]
        argument = _argument_named(node, option)
        if argument is not None and _is_switch(argument):
            parsing = f"parsing {_quoted(value)}: invalid syntax"
            return _invalid_value(
                node, option, value, f"strconv.ParseBool: {parsing}"
            )
        choices = "|".join(argument.choices) if argument is not None else ""
        return _invalid_value(
            node, option, value, f"valid values are {{{choices}}}"
        )
    return None


def group_message(message: str, token: str | None) -> str:
    """A group's option refusal, in pflag's words.

    Args:
        message (str): the walker's wording of it.
        token (str | None): the offending option, when one is unknown.
    """
    if token is not None:
        return _unknown_flag(token, ())
    if message.startswith(UNKNOWN_OPTION):
        return _unknown_flag(message[len(UNKNOWN_OPTION) :], ())
    if message.startswith(NEEDS_VALUE_HEAD) and message.endswith(
        NEEDS_VALUE_TAIL
    ):
        return _needs_value(
            message[len(NEEDS_VALUE_HEAD) : -len(NEEDS_VALUE_TAIL)], ()
        )
    return message


def _distance(left: str, right: str) -> int:
    """The Levenshtein distance between two words, ignoring case.

    Args:
        left (str): one word.
        right (str): the other.
    """
    left = left.lower()
    right = right.lower()
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + (a != b),
                )
            )
        previous = current
    return previous[-1]


def unknown_command(word: str, name: str, node: CommandSpec) -> str:
    """Cobra's refusal of a word that names no subcommand.

    Args:
        word (str): the word.
        name (str): the group's display path.
        node (CommandSpec): the group.
    """
    near = sorted(
        child.name
        for child in node.subcommands
        if _distance(word, child.name) <= SUGGESTION_DISTANCE
        or child.name.lower().startswith(word.lower())
    )
    hint = (
        "\n\nDid you mean this?\n" + "".join(f"\t{n}\n" for n in near)
        if near
        else ""
    )
    return f"unknown command {_quoted(word)} for {_quoted(name)}{hint}"
