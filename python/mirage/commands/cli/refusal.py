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

from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING

from mirage.commands.cli.constants import (
    CLAP_EXIT,
    GIT_LONG_OPTIONS,
    GIT_SYNOPSES,
    GIT_USAGE_GAP,
    GIT_USAGE_WIDTH,
    USAGE_EXIT,
)
from mirage.commands.spec.help import operand_slot, option_metavar
from mirage.commands.spec.types import CommandSpec, UsageStyle
from mirage.shell.bytes import encode_text

if TYPE_CHECKING:
    from mirage.workspace.executor.command.types import ParsedCommand

ARGPARSE_EXIT = 2
LONG_PREFIX = "--"
NEGATION = "--no-"
HELP_SWITCH = "-h"


def git_usage(path: str, spec: CommandSpec) -> str:
    """git's usage block for one verb, as parse-options prints it.

    The synopsis lines come first, the first after ``usage: `` and each
    next one after ``   or: ``, then a blank line, one row per option and
    a closing blank line. The lines are git's own (``GIT_SYNOPSES``); the
    rows are the leaf's spec in git's layout, so the block lists exactly
    the options mirage takes: four spaces, the short and long spellings,
    ``--[no-]`` where the spec declares a long's negation beside it, the
    value's name, then the description from column 26, or under that
    column on a line of its own when the spellings run past it. Pinned
    against git 2.47.3.

    Args:
        path (str): the verb's path under git ("branch", "stash list").
        spec (CommandSpec): the leaf's grammar.
    """
    lines = GIT_SYNOPSES.get(path, (f"git {path}",))
    text = f"usage: {lines[0]}\n" + "".join(
        f"   or: {line}\n" for line in lines[1:]
    )
    rows = _git_rows(path, spec)
    if rows:
        text += "\n" + "".join(rows)
    return text + "\n"


def _git_rows(path: str, spec: CommandSpec) -> list[str]:
    """One usage row per option, a negation folded where git folds it.

    git spells a long ``--[no-]name`` where its own table does
    (``GIT_LONG_OPTIONS``), and the row then stands for the plain
    boolean ``--no-name`` mirage declares beside it too. A ``--no-``
    option git lists apart (``--no-merges`` filters rather than
    negates) keeps a row of its own.

    Args:
        path (str): the verb's path under git, for its table.
        spec (CommandSpec): the leaf's grammar.
    """
    table = GIT_LONG_OPTIONS.get(path, ())
    negations = {
        opt.long
        for opt in spec.options
        if opt.long is not None
        and opt.long.startswith(NEGATION)
        and opt.short is None
        and opt.type == "bool"
        and f"[no-]{opt.long[len(NEGATION) :]}" in table
    }
    rows: list[str] = []
    for opt in spec.options:
        long = opt.long
        if long in negations:
            continue
        if long is not None and f"{NEGATION}{long[2:]}" in negations:
            long = f"--[no-]{long[2:]}"
        spelled = ", ".join(name for name in (opt.short, long) if name)
        if opt.type != "bool":
            named = opt.long[2:] if opt.long else (opt.short or "-")[1:]
            value = f"<{opt.metavar or named}>"
            if not opt.value_optional:
                spelled += f" {value}"
            else:
                spelled += f"[={value}]" if opt.long else f"[{value}]"
        left = f"    {spelled}"
        gap = (
            " " * (GIT_USAGE_WIDTH + GIT_USAGE_GAP - len(left))
            if len(left) <= GIT_USAGE_WIDTH + 1
            else "\n" + " " * (GIT_USAGE_WIDTH + GIT_USAGE_GAP)
        )
        rows.append(f"{left}{gap}{opt.description or ''}\n")
    return rows


def git_option_refusal(
    word: str, path: str, spec: CommandSpec
) -> tuple[str, str]:
    """parse-options' answer to a word the verb does not take.

    ``-h`` asks for the usage block, which goes to stdout. A boolean
    long handed a value is refused on one line. Anything else is an
    option the verb does not have: a long one is an "option" and a
    short one a "switch", both named without their dashes and quoted
    with a backquote-apostrophe pair, and the usage block follows on
    stderr. Pinned against git 2.50.1.

    Args:
        word (str): the offending word with its dashes ('--nosuch',
            '-Z', '--quiet=1').
        path (str): the verb's path under git, for its synopsis.
        spec (CommandSpec): the leaf's grammar, for its rows.

    Returns:
        The refusal's stdout and its stderr; it exits 129.
    """
    usage = git_usage(path, spec)
    if word == HELP_SWITCH:
        return usage, ""
    name, eq, _ = word.partition("=")
    if eq and any(
        opt.long == name and opt.type == "bool" for opt in spec.options
    ):
        return "", f"error: option `{name[2:]}' takes no value\n"
    noun = "option" if word.startswith(LONG_PREFIX) else "switch"
    return "", f"error: unknown {noun} `{word.lstrip('-')}'\n{usage}"


def clap_supplied(
    spec: CommandSpec, typed: Sequence[str], env: Mapping[str, str]
) -> list[str]:
    """The options a clap usage line echoes back, in clap's order.

    clap reprints the options the line carried, in the order they were
    typed, then the ones an environment variable supplied. A *defaulted*
    option is not among them: pinned against ntn 0.21.9, whose --limit
    declares ``[default: 25]`` and never appears unless it was typed.

    Args:
        spec (CommandSpec): the leaf's grammar, for spellings and value
            names.
        typed (Sequence[str]): dests the line carried, in scan order.
            Canonical dashed spellings, the key space the parser records
            flags under.
        env (Mapping[str, str]): the session environment, read for the
            options that declare a variable.
    """
    by_dest = {opt.long or opt.short or "": opt for opt in spec.options}
    bits: list[str] = []
    for dest in typed:
        opt = by_dest.get(dest)
        if opt is None:
            continue
        if opt.type == "bool":
            bits.append(dest)
        else:
            bits.append(f"{dest} <{option_metavar(opt)}>")
    for dest, opt in by_dest.items():
        if opt.env is None or dest in typed or opt.env not in env:
            continue
        bits.append(f"{dest} <{option_metavar(opt)}>")
    return bits


def clap_operands(spec: CommandSpec) -> list[str]:
    """Every operand slot of a leaf, as a clap usage line spells them.

    Args:
        spec (CommandSpec): the leaf's grammar.
    """
    slots = [operand_slot(operand) for operand in spec.positional]
    if spec.rest is not None:
        slots.append(operand_slot(spec.rest, ellipsis=not spec.rest.required))
    return slots


def clap_missing_operands(
    prog: str,
    spec: CommandSpec,
    missing: Sequence[str],
    typed: Sequence[str],
    env: Mapping[str, str],
) -> bytes:
    """clap's refusal for required operands the line did not supply.

    Pinned against ntn 0.21.9: the empty slots are listed one per line
    under a fixed heading, then a usage line that carries the options
    the line supplied and every operand slot, then the "try --help"
    footer. The usage line names only what was supplied, which is why it
    is rebuilt here rather than taken from the help page.

    Args:
        prog (str): the full display path of the leaf ("ntn pages get").
        spec (CommandSpec): the leaf's grammar.
        missing (Sequence[str]): bare names of the empty required slots.
        typed (Sequence[str]): dests the line carried, in scan order.
        env (Mapping[str, str]): the session environment.
    """
    named = "\n".join(f"  <{name}>" for name in missing)
    bits = [prog, *clap_supplied(spec, typed, env), *clap_operands(spec)]
    usage = " ".join(bits)
    return encode_text(
        "error: the following required arguments were not provided:\n"
        f"{named}\n\nUsage: {usage}\n\n"
        "For more information, try '--help'.\n"
    )


def leaf_refusal(
    style: UsageStyle,
    argparse_message: bytes,
    parsed: "ParsedCommand",
    path: str,
    spec: CommandSpec,
) -> tuple[bytes, int, bytes | None]:
    """The message and exit code a leaf answers a bad option with.

    A leaf usage error exits 2 under argparse's style regardless of the
    GNU USAGE_EXIT table, because an installed CLI name is never a GNU
    tool with its own pinned exit. git exits 129 for the same mistake,
    which is neither that nor its own 128 for a fatal. clap exits 2,
    agreeing with argparse by coincidence rather than by lineage.

    git answers in parse-options' words, and some of them print the
    verb's usage block: after an unknown option on stderr, on stdout
    for ``-h`` and after an ambiguous abbreviation. A missing value is
    one line, a long named an "option" and a short one a "switch"
    (pinned against git 2.50.1).

    Args:
        style (UsageStyle): the dialect the CLI's root declares.
        argparse_message (bytes): the message the spec machinery built,
            used as-is for argparse and for anything another style words
            the same.
        parsed (ParsedCommand): parse result, read for the offending
            token when the style rewrites the message.
        path (str): the leaf's path under its head word, for git's
            synopsis.
        spec (CommandSpec): the leaf's grammar, for git's option rows.

    Returns:
        The stderr, the exit code and the stdout, None when the refusal
        writes nothing there.
    """
    if style is UsageStyle.CLAP:
        return argparse_message, CLAP_EXIT, None
    if style is not UsageStyle.GIT:
        return argparse_message, ARGPARSE_EXIT, None
    kinds = parsed.option_error_kinds
    kind = kinds[0] if kinds else None
    if kind == "ambiguous" and parsed.ambiguous_options:
        token, candidates = parsed.ambiguous_options[0]
        first, second = (list(candidates) + ["", ""])[:2]
        line = (
            f"error: ambiguous option: {token[2:]} "
            f"(could be {first} or {second})\n"
        )
        return (
            encode_text(line),
            USAGE_EXIT,
            encode_text(git_usage(path, spec)),
        )
    if kind == "needs_value" and parsed.needs_value_options:
        needy = parsed.needs_value_options[0]
        named = (
            f"option `{needy[2:]}'"
            if needy.startswith(LONG_PREFIX)
            else f"switch `{needy.lstrip('-')}'"
        )
        return (
            encode_text(f"error: {named} requires a value\n"),
            USAGE_EXIT,
            None,
        )
    if kind in ("invalid", "unexpected_value") and parsed.invalid_options:
        token = parsed.invalid_options[0]
        word = token if token.startswith("-") else f"-{token}"
        shown, refused = git_option_refusal(word, path, spec)
        return encode_text(refused), USAGE_EXIT, encode_text(shown) or None
    return argparse_message, USAGE_EXIT, None


def directory_refusal(
    prog: str, path: str, reason: str, style: UsageStyle
) -> tuple[bytes, int]:
    """Render failure to enter a CLI's declared operand base.

    Args:
        prog (str): installed program name.
        path (str): directory as the user supplied it.
        reason (str): dispatcher refusal in platform-independent words.
        style (UsageStyle): the program's diagnostic style.
    """
    if style is UsageStyle.GIT:
        return encode_text(
            f"fatal: cannot change to '{path}': {reason}\n"
        ), 128
    return encode_text(
        f"{prog}: cannot change directory to '{path}': {reason}\n"
    ), 1
