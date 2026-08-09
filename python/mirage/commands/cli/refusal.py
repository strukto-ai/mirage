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

from mirage.commands.cli.constants import USAGE_EXIT
from mirage.commands.spec.help import operand_slot, option_metavar
from mirage.commands.spec.types import CommandSpec, UsageStyle
from mirage.workspace.executor.command.types import ParsedCommand

ARGPARSE_EXIT = 2
CLAP_EXIT = 2
LONG_PREFIX = "--"


def git_unknown_option(token: str) -> bytes:
    """git's refusal for an option it does not know.

    Two nouns and no program name, pinned against git 2.50.1: a long
    option is an "option" and a short one is a "switch", both named
    without their dashes and quoted with a backquote-apostrophe pair.
    git follows this with the verb's usage block, which is omitted the
    same way GNU's is elsewhere in the spec machinery.

    Args:
        token (str): the offending token ('--nosuch') or cluster
            character ('Z'), as the flat parser reports it.
    """
    noun = "option" if token.startswith(LONG_PREFIX) else "switch"
    return f"error: unknown {noun} `{token.lstrip('-')}'\n".encode()


def clap_supplied(spec: CommandSpec, typed: Sequence[str],
                  env: Mapping[str, str]) -> list[str]:
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


def clap_missing_operands(prog: str, spec: CommandSpec, missing: Sequence[str],
                          typed: Sequence[str], env: Mapping[str,
                                                             str]) -> bytes:
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
    return ("error: the following required arguments were not provided:\n"
            f"{named}\n\nUsage: {usage}\n\n"
            "For more information, try '--help'.\n").encode()


def leaf_refusal(style: UsageStyle, argparse_message: bytes,
                 parsed: ParsedCommand) -> tuple[bytes, int]:
    """The message and exit code a leaf answers a bad option with.

    A leaf usage error exits 2 under argparse's style regardless of the
    GNU USAGE_EXIT table, because an installed CLI name is never a GNU
    tool with its own pinned exit. git exits 129 for the same mistake,
    which is neither that nor its own 128 for a fatal. clap exits 2,
    agreeing with argparse by coincidence rather than by lineage.

    Args:
        style (UsageStyle): the dialect the CLI's root declares.
        argparse_message (bytes): the message the spec machinery built,
            used as-is for argparse and for anything another style words
            the same.
        parsed (ParsedCommand): parse result, read for the offending
            token when the style rewrites the message.
    """
    if style is UsageStyle.CLAP:
        return argparse_message, CLAP_EXIT
    if style is not UsageStyle.GIT:
        return argparse_message, ARGPARSE_EXIT
    if parsed.invalid_options:
        return git_unknown_option(parsed.invalid_options[0]), USAGE_EXIT
    return argparse_message, USAGE_EXIT
