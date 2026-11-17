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

from collections.abc import Iterable, Mapping, Sequence
from functools import lru_cache

from mirage.commands.cli.walk import find_child, leaf_parse
from mirage.commands.spec.compile import (
    CompiledSpec,
    argument_dest,
    compile_spec,
)
from mirage.commands.spec.parser import ParsedArgs, parse_command
from mirage.commands.spec.types import CommandSpec, FlagValue
from mirage.policy.match.pattern import expand_pattern, split_pattern
from mirage.policy.types import (
    AdmissionRules,
    CommandRead,
    FlagFact,
    Grammar,
)
from mirage.types import PathSpec

STAR = "*"
HELP_WORDS = frozenset({"--help", "--version"})
CACHE_SIZE = 4096

_PATTERNS: dict[
    tuple[int, bool, bool, tuple[str, ...]],
    tuple[CommandSpec, CommandRead | None],
] = {}


def _values(value: FlagValue | None) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(v for part in value for v in _values(part))
    if isinstance(value, PathSpec):
        return (value.virtual,)
    if isinstance(value, str):
        return (value,)
    return ()


def flag_facts(
    flags: Mapping[str, FlagValue], dests: Iterable[str]
) -> tuple[FlagFact, ...]:
    """Each named option with the values it holds.

    Args:
        flags (Mapping[str, FlagValue]): option values by canonical
            spelling, as a parse or a walk left them.
        dests (Iterable[str]): the options the words carry, in order.
    """
    return tuple(FlagFact(dest, _values(flags.get(dest))) for dest in dests)


def refused(parsed: ParsedArgs, pattern: bool = False) -> bool:
    """Whether the grammar refuses the words' options. A missing operand
    or required option does not count, and in a pattern neither does an
    option written without its value, which matches any value.

    Args:
        parsed (ParsedArgs): the parse.
        pattern (bool): whether the words are a rule pattern's.
    """
    kinds = [
        kind
        for kind in parsed.option_error_kinds
        if not (pattern and kind == "needs_value")
    ]
    return bool(kinds) or parsed.old_option_needs_value is not None


def leaf_read(
    path: tuple[str, ...],
    parsed: ParsedArgs,
    pattern: CommandSpec | None = None,
) -> CommandRead | None:
    """A leaf's parse as a read: the options the words carry, typed or
    filled from the environment, never a declared default, and the
    operands as written. None when the grammar refuses the words.

    Args:
        path (tuple[str, ...]): the command name and its subcommands.
        parsed (ParsedArgs): the leaf's parse.
        pattern (CommandSpec | None): the spec that read a rule pattern's
            words, where an option written without its value matches
            any value; None for a line's.
    """
    if refused(parsed, pattern is not None):
        return None
    dests = [*parsed.typed_dests, *parsed.env_dests]
    flags = flag_facts(parsed.flags, dests)
    if pattern is not None:
        cs = compile_spec(pattern)
        flags += tuple(
            FlagFact(dest)
            for dest in (
                cs.dest_of(v if v.startswith("-") else f"-{v}")
                for v in parsed.needs_value_options
            )
            if dest not in dests
        )
    return CommandRead(
        path, flags, tuple(word for word, _ in parsed.raw_operands)
    )


def abbreviated(cs: CompiledSpec, words: Sequence[str]) -> bool:
    """Whether a pattern writes a long option by a prefix of its name.
    A line may, a pattern may not: ``--rec`` reads as a rule on whatever
    the prefix names today, and a new option can change that.

    Args:
        cs (CompiledSpec): the node's compiled tables.
        words (Sequence[str]): the pattern's words below the node.
    """
    for word in words:
        if word == "--":
            return False
        if not word.startswith("--"):
            continue
        name = word.partition("=")[0]
        if name not in cs.dest and any(
            spelling.startswith(name)
            for spelling in cs.dest
            if spelling.startswith("--")
        ):
            return True
    return False


def _read_once(grammar: Grammar, words: tuple[str, ...]) -> CommandRead | None:
    node, path, rest = _descend(grammar, words)
    if grammar.passthrough and not node.subcommands:
        return CommandRead(path, (), rest)
    if abbreviated(compile_spec(node), rest):
        return None
    prog = " ".join(path)
    if node.subcommands:
        parsed = parse_command(node, list(rest), "/", prog)
        if parsed.raw_operands:
            return None
        return leaf_read(path, parsed, node)
    if not grammar.tree:
        return leaf_read(
            path, parse_command(node, list(rest), "/", prog), node
        )
    rules = leaf_parse(grammar.spec, node, path[1:], grammar.passthrough)
    parsed = parse_command(
        rules.spec,
        list(rest),
        "/",
        prog,
        unknown_is_operand=rules.unknown_is_operand,
        abbreviations=rules.abbreviations,
    )
    return leaf_read(path, parsed, rules.spec)


def read_pattern(grammar: Grammar, words: Sequence[str]) -> CommandRead | None:
    """A rule pattern read with the grammar of the line it is compared
    to, as the line itself was read: subcommands by their canonical
    names, options by their canonical spellings with the values the
    pattern gives them. None when the grammar refuses it, or it names a
    long option by a prefix. Kept per grammar and pattern.

    Args:
        grammar (Grammar): the line's grammar.
        words (Sequence[str]): the pattern's words, command name first.
    """
    key = (id(grammar.spec), grammar.tree, grammar.passthrough, tuple(words))
    hit = _PATTERNS.get(key)
    if hit is not None and hit[0] is grammar.spec:
        return hit[1]
    read = _read_once(grammar, tuple(words))
    if len(_PATTERNS) >= CACHE_SIZE:
        _PATTERNS.clear()
    _PATTERNS[key] = (grammar.spec, read)
    return read


def bind(
    grammar: Grammar, words: Sequence[str], path: Sequence[str]
) -> tuple[tuple[str, ...], bool] | None:
    """A pattern with each subcommand ``*`` replaced by the line's
    subcommand at that place, and whether it held one. A ``*`` stands
    for a subcommand while the node it sits under has subcommands, and
    for an operand once the pattern reaches a leaf. None when the line
    has no subcommand there.

    Args:
        grammar (Grammar): the line's grammar.
        words (Sequence[str]): the pattern's words, command name first.
        path (Sequence[str]): the line's command name and canonical
            subcommands.
    """
    if not grammar.tree or STAR not in words[1:]:
        return tuple(words), False
    node = grammar.spec
    out = [words[0]]
    starred = False
    for at in range(1, len(words)):
        word = words[at]
        if not node.subcommands:
            return (*out, *words[at:]), starred
        if word == STAR:
            if at >= len(path):
                return None
            word = path[at]
            starred = True
        child = None if word.startswith("-") else find_child(node, word)
        if child is None:
            return (*out, *words[at:]), starred
        out.append(child.name)
        node = child
    return tuple(out), starred


def allow_patterns(rules: AdmissionRules) -> tuple[str, ...]:
    """The allow list's patterns, each group expanded. A ``{command,
    flags}`` entry stands as its command and options in one pattern
    (``AllowFlags.pattern``).

    Args:
        rules (AdmissionRules): the session's rules.
    """
    return tuple(
        p
        for entry in rules.allow or ()
        for p in (
            expand_pattern(entry)
            if isinstance(entry, str)
            else (entry.pattern,)
        )
    )


def expanded_patterns(rules: AdmissionRules) -> tuple[str, ...]:
    """Every command pattern a rule set holds, each group expanded, its
    allow list first.

    Args:
        rules (AdmissionRules): the session's rules.
    """
    return (
        *allow_patterns(rules),
        *(
            p
            for rule in (*rules.deny, *rules.ask)
            for written in rule.commands
            for p in expand_pattern(written)
        ),
    )


@lru_cache(maxsize=CACHE_SIZE)
def pattern_reads(
    rules: AdmissionRules, path: tuple[str, ...], grammar: Grammar
) -> tuple[tuple[str, CommandRead | None], ...]:
    """Each pattern on the line's command, read with the line's grammar,
    keyed by the pattern as its group expanded. A pattern the grammar
    refuses is left out and matched word by word; one whose subcommand
    ``*`` cannot read on this line reads as None, which never matches.

    Args:
        rules (AdmissionRules): the session's rules.
        path (tuple[str, ...]): the line's command name and canonical
            subcommands.
        grammar (Grammar): the line's grammar.
    """
    out: dict[str, CommandRead | None] = {}
    for pattern in expanded_patterns(rules):
        if pattern in out:
            continue
        words = split_pattern(pattern)
        if not words or words[0] != path[0]:
            continue
        bound = bind(grammar, words, path)
        if bound is None:
            out[pattern] = None
            continue
        read = read_pattern(grammar, bound[0])
        if read is not None or bound[1]:
            out[pattern] = read
    return tuple(out.items())


def _descend(
    grammar: Grammar, words: Sequence[str]
) -> tuple[CommandSpec, tuple[str, ...], tuple[str, ...]]:
    node = grammar.spec
    path = [words[0]]
    at = 1
    while grammar.tree and node.subcommands and at < len(words):
        word = words[at]
        child = None if word.startswith("-") else find_child(node, word)
        if child is None:
            break
        node = child
        path.append(child.name)
        at += 1
    return node, tuple(path), tuple(words[at:])


def _options(words: Sequence[str]) -> list[str]:
    out: list[str] = []
    for word in words:
        if word == "--":
            break
        if word.startswith("-") and word != "-":
            out.append(word)
    return out


def _bindings(
    grammar: Grammar, words: tuple[str, ...]
) -> list[tuple[str, ...]]:
    """Each pattern a subcommand ``*`` can bind to, one per node.

    Args:
        grammar (Grammar): the command's grammar, a command tree.
        words (tuple[str, ...]): the pattern's words, command name first.
    """
    out: list[tuple[str, ...]] = []

    def fill(node: CommandSpec, done: tuple[str, ...], at: int) -> None:
        if at >= len(words) or not node.subcommands:
            out.append((*done, *words[at:]))
            return
        word = words[at]
        if word == STAR:
            for sub in node.subcommands:
                fill(sub, (*done, sub.name), at + 1)
            return
        child = None if word.startswith("-") else find_child(node, word)
        if child is None:
            out.append((*done, *words[at:]))
            return
        fill(child, (*done, child.name), at + 1)

    fill(grammar.spec, (words[0],), 1)
    return out


def env_options(grammar: Grammar, words: Sequence[str]) -> dict[str, str]:
    """The options a line under a command may have filled from the
    environment, by variable: those of the node ``words`` name, of its
    ancestors and of every subcommand below it, by canonical spelling.

    Args:
        grammar (Grammar): the command's grammar.
        words (Sequence[str]): the command name and its subcommands.
    """
    node = grammar.spec
    found = list(node.arguments)
    for word in words[1:]:
        child = find_child(node, word) if grammar.tree else None
        if child is None:
            break
        node = child
        found += child.arguments
    below = list(node.subcommands)
    while below:
        sub = below.pop()
        found += sub.arguments
        below += sub.subcommands
    return {a.env: argument_dest(a) for a in found if a.env}


def undeclared_options(grammar: Grammar, words: Sequence[str]) -> list[str]:
    """The dashed words a command tree's leaf reads as operands in a
    pattern, because it declares no such option: the line reads them so
    too, and the pattern matches only a line that carries the same word.

    Args:
        grammar (Grammar): the command's grammar.
        words (Sequence[str]): the pattern's words, command name first.
    """
    if not grammar.tree or STAR in words[1:]:
        return []
    read = read_pattern(grammar, words)
    if read is None:
        return []
    dashed = set(_options(words[len(read.path) :]))
    return [word for word in read.operands if word in dashed]


def pattern_problem(grammar: Grammar, words: Sequence[str]) -> str | None:
    """Why a pattern cannot be read the way it is written on its
    command, None when it can: a subcommand the command lacks, a long
    option written by a prefix of its name, an option the command does
    not have (a command tree's leaf takes an undeclared dashed word as
    an operand only where it has a slot for one), or, past a subcommand
    ``*``, an option written short or one no subcommand there declares.
    A help or version request matches word by word, as its line does,
    and the pattern's other words are checked without it.

    Args:
        grammar (Grammar): the command's grammar.
        words (Sequence[str]): the pattern's words, command name first.
    """
    words = tuple(words)
    asked = tuple(word for word in words if word not in HELP_WORDS)
    if len(asked) < len(words):
        return pattern_problem(grammar, asked)
    if grammar.tree and STAR in words[1:]:
        shorts = [o for o in _options(words) if not o.startswith("--")]
        if shorts:
            return (
                f"{shorts[0]} follows a subcommand *, where a short option "
                "can name a different option per subcommand; write its "
                "long name"
            )
        if not _options(words):
            return None
        if any(
            read_pattern(grammar, b) is not None
            for b in _bindings(grammar, words)
        ):
            return None
        return (
            f"no {words[0]} subcommand the * stands for has "
            f"{' '.join(_options(words))}"
        )
    node, path, rest = _descend(grammar, words)
    prog = " ".join(path)
    if (
        grammar.tree
        and node.subcommands
        and rest
        and not rest[0].startswith("-")
        and rest[0] != STAR
    ):
        return f"the {words[0]} CLI has no verb {prog} {rest[0]}"
    cs = compile_spec(node)
    for option in _options(rest):
        name = option.partition("=")[0]
        if name.startswith("--") and abbreviated(cs, (name,)):
            return f"{name} is a prefix of an option; write the option in full"
    if read_pattern(grammar, words) is not None:
        return None
    if grammar.tree and not node.subcommands:
        return f"{prog} does not read {' '.join(rest)}"
    parsed = parse_command(node, list(rest), "/", prog)
    if parsed.invalid_options:
        bad = parsed.invalid_options[0]
        shown = bad if bad.startswith("-") else f"-{bad}"
        return f"{prog} has no option {shown}"
    return f"{prog} does not read {' '.join(rest)}"
