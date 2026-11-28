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

# Follows commander 15.1.0's usage refusals and the close-match
# suggestion of its lib/suggestSimilar.js (MIT; see
# licenses/third_party/commander.txt), the parser tvly 1.0.2 is built on.

from collections.abc import Sequence

from mirage.commands.spec.types import Argument, CommandSpec

# tvly exits 2 for every refusal commander raises (src/cli.ts maps each
# CommanderError to it); commander left alone exits 1.
COMMANDER_EXIT = 2
MAX_DISTANCE = 3
MIN_SIMILARITY = 0.4
HELP_LONG = "--help"


def edit_distance(a: str, b: str) -> int:
    """Optimal string alignment distance: insertions, deletions,
    substitutions and adjacent transpositions, none edited twice.

    Args:
        a (str): one word.
        b (str): the other.
    """
    if abs(len(a) - len(b)) > MAX_DISTANCE:
        return max(len(a), len(b))
    d = [[i] + [0] * len(b) for i in range(len(a) + 1)]
    d[0] = list(range(len(b) + 1))
    for j in range(1, len(b) + 1):
        for i in range(1, len(a) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(
                d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost
            )
            if (
                i > 1
                and j > 1
                and a[i - 1] == b[j - 2]
                and a[i - 2] == b[j - 1]
            ):
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def suggest_similar(word: str, candidates: Sequence[str]) -> str:
    """The ``(Did you mean ...?)`` line for a word close to a candidate,
    or nothing; only the candidates at the best distance are named.

    Args:
        word (str): what the line typed.
        candidates (Sequence[str]): what it may have meant.
    """
    pool = list(dict.fromkeys(candidates))
    if not pool:
        return ""
    options = word.startswith("--")
    if options:
        word = word[2:]
        pool = [candidate[2:] for candidate in pool]
    similar: list[str] = []
    best = MAX_DISTANCE
    for candidate in pool:
        if len(candidate) <= 1:
            continue
        distance = edit_distance(word, candidate)
        length = max(len(word), len(candidate))
        if (length - distance) / length > MIN_SIMILARITY:
            if distance < best:
                best = distance
                similar = [candidate]
            elif distance == best:
                similar.append(candidate)
    similar.sort()
    if options:
        similar = [f"--{candidate}" for candidate in similar]
    if len(similar) > 1:
        return f"\n(Did you mean one of {', '.join(similar)}?)"
    if similar:
        return f"\n(Did you mean {similar[0]}?)"
    return ""


def long_options(nodes: Sequence[CommandSpec]) -> list[str]:
    """Every long option the nodes declare, ``--help`` among them, the
    candidates commander suggests from.

    Args:
        nodes (Sequence[CommandSpec]): the leaf, then its ancestors.
    """
    names: list[str] = []
    for node in nodes:
        for argument in node.arguments:
            names.extend(n for n in argument.names if n.startswith("--"))
        names.append(HELP_LONG)
    return names


def option_flags(argument: Argument) -> str:
    """The option as commander spells it in a refusal: its names, then
    ``<value>`` for a value it needs or ``[value]`` for one it may take.

    Args:
        argument (Argument): the option.
    """
    names = ", ".join(argument.names)
    if argument.action in ("store_true", "count"):
        return names
    value = argument.metavar or argument.names[-1].lstrip("-")
    bare = value.strip("<>[]")
    shown = f"[{bare}]" if argument.nargs == "?" else f"<{bare}>"
    return f"{names} {shown}"


def unknown_option(token: str, nodes: Sequence[CommandSpec]) -> str:
    """The refusal of an option no node declares.

    Args:
        token (str): the option as typed.
        nodes (Sequence[CommandSpec]): the leaf, then its ancestors.
    """
    suggestion = (
        suggest_similar(token, long_options(nodes))
        if token.startswith("--")
        else ""
    )
    return f"error: unknown option '{token}'{suggestion}\n"


def missing_value(token: str, node: CommandSpec) -> str | None:
    """The refusal of an option typed last with no value after it.

    Args:
        token (str): the option as typed.
        node (CommandSpec): the node that declares it.
    """
    for argument in node.arguments:
        if token in argument.names:
            return (
                f"error: option '{option_flags(argument)}' argument missing\n"
            )
    return None


def excess_arguments(words: Sequence[str], verb: str | None = None) -> str:
    """The refusal of operands a command with none declared was given.

    Args:
        words (Sequence[str]): the operands.
        verb (str | None): the subcommand, None at the program's root.
    """
    target = f" for '{verb}'" if verb is not None else ""
    return (
        f"error: too many arguments{target}. Expected 0 arguments but got "
        f"{len(words)}: {', '.join(words)}.\n"
    )
