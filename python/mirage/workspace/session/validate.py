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

from collections.abc import Collection, Iterator, Mapping
from dataclasses import replace
from types import MappingProxyType

from mirage.commands.cli.walk import find_child
from mirage.commands.spec import SPECS
from mirage.commands.spec.compile import argument_dest, compile_spec
from mirage.commands.spec.types import CommandSpec
from mirage.policy.errors import PolicyError
from mirage.policy.types import (
    AdmissionRules,
    CommandNode,
    Grammar,
    OptionRule,
    ScopedTree,
    ValueRule,
)
from mirage.workspace.lookup.constants import NOT_INSTALLABLE

BUILTIN_GRAMMARS: Mapping[str, Grammar] = MappingProxyType(
    {name: Grammar(spec) for name, spec in SPECS.items()}
)

RESERVED_WORDS = frozenset(
    {"decision", "reason", "paths", "operands", "values"}
)
VALUELESS_ACTIONS = frozenset({"store_true", "count"})
GLOB_CHARS = frozenset("*?[")


def _at_or_below(node: CommandSpec) -> Iterator[CommandSpec]:
    yield node
    for child in node.subcommands:
        yield from _at_or_below(child)


def _cluster(key: str, node: CommandSpec) -> bool:
    if key.startswith("--") or len(key) < 3:
        return False
    shorts = {
        spelling
        for spec in _at_or_below(node)
        for spelling in compile_spec(spec).dest
    }
    return all(f"-{letter}" in shorts for letter in key[1:])


def _option_name(key: str, node: CommandSpec, at: str) -> str:
    own = compile_spec(node).dest.get(key)
    if own is not None:
        return own
    meanings = sorted(
        {
            dest
            for spec in _at_or_below(node)
            if (dest := compile_spec(spec).dest.get(key)) is not None
        }
    )
    if len(meanings) == 1:
        return meanings[0]
    if meanings:
        raise PolicyError(
            f"{at}: {key} names different options below "
            f"({', '.join(meanings)}); write the long name you mean, or "
            "put the entry under its subcommand"
        )
    if _cluster(key, node):
        keys = " and ".join(f"-{letter}" for letter in key[1:])
        raise PolicyError(
            f"{at}: {key} is a cluster of options; write {keys} as "
            "separate keys"
        )
    raise PolicyError(f"{at}: no option {key} at or below this command")


def _check_values(
    name: str, words: Collection[str], node: CommandSpec, at: str
) -> None:
    arguments = [
        argument
        for spec in _at_or_below(node)
        for argument in spec.arguments
        if argument.names[0].startswith("-")
        and argument_dest(argument) == name
    ]
    if all(
        argument.action in VALUELESS_ACTIONS or argument.nargs == 0
        for argument in arguments
    ):
        raise PolicyError(f"{at}: {name} takes no value")
    choices = {choice for argument in arguments for choice in argument.choices}
    if not choices or any(not argument.choices for argument in arguments):
        return
    for word in words:
        if not GLOB_CHARS & set(word) and word not in choices:
            raise PolicyError(
                f"{at}: {name} takes none of {word!r}; its values are "
                f"{', '.join(sorted(choices))}"
            )


def _options(
    options: Mapping[str, OptionRule],
    node: CommandSpec,
    at: str,
    passthrough: bool,
) -> dict[str, OptionRule]:
    out: dict[str, OptionRule] = {}
    written: dict[str, str] = {}
    for key, rule in options.items():
        here = f"{at}.{key}"
        if passthrough:
            raise PolicyError(
                f"{here}: this command's script reads its own words, so "
                "it has no option to name"
            )
        name = _option_name(key, node, here)
        if name in written:
            raise PolicyError(
                f"{at}: {written[name]} and {key} are the same option"
            )
        written[name] = key
        if rule.values:
            _check_values(name, rule.values, node, here)
        out[name] = OptionRule(
            decision=rule.decision,
            values={
                word: ValueRule(
                    decision=value.decision,
                    options=_options(
                        value.options, node, f"{here}.values.{word}", False
                    ),
                )
                for word, value in rule.values.items()
            },
            options=_options(rule.options, node, here, False),
        )
    return out


def _no_grammar(tree: CommandNode, at: str) -> CommandNode:
    if tree.options or tree.other_options:
        raise PolicyError(
            f"{at}: this command has no grammar here to read an option by"
        )
    if tree.subcommands:
        raise PolicyError(
            f"{at}: {next(iter(tree.subcommands))} is no subcommand here; "
            "an operand goes under operands"
        )
    return replace(
        tree,
        operands={
            word: _no_grammar(node, f"{at}.operands.{word}")
            for word, node in tree.operands.items()
        },
    )


def _reserved(node: CommandSpec) -> str | None:
    return next(
        (
            word
            for child in node.subcommands
            for word in (child.name, *child.aliases)
            if word in RESERVED_WORDS
        ),
        None,
    )


def _plain(tree: CommandNode) -> bool:
    bare = not (
        tree.subcommands or tree.options or tree.other_options or tree.operands
    )
    return bare and all(
        not leaf.reason and not leaf.paths for leaf in tree.decision
    )


def _node(
    tree: CommandNode, node: CommandSpec, at: str, passthrough: bool
) -> CommandNode:
    reserved = _reserved(node)
    if reserved is not None and not _plain(tree):
        raise PolicyError(
            f"{at}: this command has a subcommand named {reserved}, which "
            "a commands block reserves; write it a plain allow, ask or "
            "deny"
        )
    subcommands: dict[str, CommandNode] = {}
    written: dict[str, str] = {}
    for key, child in tree.subcommands.items():
        found = find_child(node, key)
        if found is None and not node.subcommands:
            raise PolicyError(
                f"{at}: {key} is no subcommand here; an operand goes under "
                "operands"
            )
        if found is None:
            raise PolicyError(f"{at}: no subcommand {key}")
        if found.name in written:
            raise PolicyError(
                f"{at}: {written[found.name]} and {key} are the same "
                "subcommand"
            )
        written[found.name] = key
        subcommands[found.name] = _node(
            child, found, f"{at}.{found.name}", passthrough
        )
    if tree.operands and node.subcommands:
        raise PolicyError(
            f"{at}: this command takes a subcommand, so its operands go "
            "under one"
        )
    if tree.other_options and passthrough:
        raise PolicyError(
            f"{at}.-*: this command's script reads its own words, so it "
            "has no option to name"
        )
    return CommandNode(
        decision=tree.decision,
        subcommands=subcommands,
        options=_options(tree.options, node, at, passthrough),
        other_options=tree.other_options,
        operands={
            word: _node(child, node, f"{at}.operands.{word}", passthrough)
            for word, child in tree.operands.items()
        },
    )


def normalize_tree(
    tree: CommandNode,
    grammars: Mapping[str, Grammar],
    where: str = "commands",
    defer: bool = False,
) -> CommandNode:
    """A command tree with every name checked against its command's
    grammar and held by its canonical name, the one the line reader
    reports.

    A subcommand is held by its spec name, an option by its first long
    name or its short name when it has none. Refused: a name the grammar
    lacks; two keys for one option or one subcommand; a cluster of
    short options; a short option meaning different options in the
    subcommands below; operands on a command that takes a subcommand;
    a value under an option that takes none, or outside its choices;
    and options or subcommands on a command with no grammar, since the
    line reader gives it only operands.

    Args:
        tree (CommandNode): the tree as written.
        grammars (Mapping[str, Grammar]): each command's grammar by
            name.
        where (str): the block's name, for the messages.
        defer (bool): keep a command with no grammar as written rather
            than refuse its names, for a check made before every CLI is
            registered. A name no CLI can be installed under (a shell
            builtin, a keyword) is checked all the same.

    Raises:
        PolicyError: a name does not fit its command's grammar.
    """
    commands: dict[str, CommandNode] = {}
    for name, node in tree.subcommands.items():
        grammar = grammars.get(name)
        at = f"{where}.{name}"
        if grammar is None:
            later = defer and name not in NOT_INSTALLABLE
            commands[name] = node if later else _no_grammar(node, at)
            continue
        commands[name] = _node(node, grammar.spec, at, grammar.passthrough)
    return replace(tree, subcommands=commands)


def renormalized(
    rules: AdmissionRules | None, grammars: Mapping[str, Grammar]
) -> AdmissionRules | None:
    """A session's command trees held again by the canonical names of
    the grammars the workspace has now, for a command that had none
    when the trees were compiled and has since been registered.

    Args:
        rules (AdmissionRules | None): the session's trees.
        grammars (Mapping[str, Grammar]): each command's grammar by name.

    Raises:
        PolicyError: a name does not fit the grammar its command has now.
    """
    if rules is None:
        return None
    return AdmissionRules(
        tuple(
            ScopedTree(
                normalize_tree(scoped.tree, grammars, defer=True),
                scoped.mount,
                scoped.inline,
            )
            for scoped in rules.trees
        )
    )
