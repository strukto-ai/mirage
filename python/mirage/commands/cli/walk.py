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

from collections.abc import Sequence

from mirage.commands.cli.help import render_group_help
from mirage.commands.cli.types import CLISpec, WalkResult
from mirage.commands.spec.compile import CompiledSpec, compile_spec

FlagBag = dict[str, str | bool | int | list[str]]

# git prints usage errors at tree levels with exit 129; leaf spec errors
# keep the GNU exit-2 machinery they already ride.
USAGE_EXIT = 129


def _usage_error(name: str, node: CLISpec, message: str) -> WalkResult:
    """Group-level option refusal: message plus the node's usage block.

    Mirrors git's shape (`unknown option: --zzz` followed by the usage
    listing, exit 129). One wording for every level; git itself uses two.

    Args:
        name (str): display path walked so far, e.g. "gws gmail".
        node (CLISpec): the group node being parsed.
        message (str): first line of the refusal.
    """
    text = f"{message}\n\n{render_group_help(name, node)}"
    return WalkResult(output=text.encode(),
                      stream="stderr",
                      exit_code=USAGE_EXIT)


def _unknown_verb(head: str, name: str, word: str) -> WalkResult:
    """git's unknown-command refusal, with the group path in the noun.

    Args:
        head (str): installed head word ("gws").
        name (str): display path walked so far ("gws gmail").
        word (str): the word that matched no subcommand.
    """
    text = (f"{head}: '{word}' is not a {name} command. "
            f"See '{name} --help'.\n")
    return WalkResult(output=text.encode(), stream="stderr", exit_code=1)


def _record_bool(flags: FlagBag, cs: CompiledSpec, spelling: str) -> None:
    """Record a boolean occurrence under its canonical dashed spelling.

    Args:
        flags (FlagBag): accumulated group flags.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): dashed spelling as typed.
    """
    dest = cs.dest_of(spelling)
    if dest in cs.count_dests:
        prev = flags.get(dest)
        flags[dest] = prev + 1 if isinstance(prev, int) else 1
    else:
        flags[dest] = True


def _record_value(flags: FlagBag, cs: CompiledSpec, spelling: str,
                  value: str) -> None:
    """Record a value occurrence under its canonical dashed spelling.

    Args:
        flags (FlagBag): accumulated group flags.
        cs (CompiledSpec): the node's compiled tables.
        spelling (str): dashed spelling as typed.
        value (str): the flag's value.
    """
    dest = cs.dest_of(spelling)
    if dest in cs.multiple_dests:
        prev = flags.get(dest)
        if isinstance(prev, list):
            prev.append(value)
        else:
            flags[dest] = [value]
    else:
        flags[dest] = value


def _finish_node(name: str, node: CLISpec, cs: CompiledSpec,
                 flags: FlagBag) -> WalkResult | None:
    """Apply a node's declarative option rules after its scan.

    Defaults land as if typed, then choices and required are enforced,
    the same order the flat parser uses. Returns a rendered refusal or
    None when the node is satisfied.

    Args:
        name (str): display path walked so far.
        node (CLISpec): the group node just scanned.
        cs (CompiledSpec): the node's compiled tables.
        flags (FlagBag): accumulated group flags.
    """
    for dest, default in cs.defaults.items():
        if dest not in flags:
            if dest in cs.multiple_dests:
                flags[dest] = [default]
            else:
                flags[dest] = default
    for dest, allowed in cs.choices_by_dest.items():
        value = flags.get(dest)
        candidates = value if isinstance(
            value, list) else ([value] if isinstance(value, str) else [])
        for part in candidates:
            if part not in allowed:
                return _usage_error(
                    name, node,
                    f"error: invalid argument '{part}' for '{dest}'")
    for dest in cs.required_dests:
        if dest not in flags:
            return _usage_error(name, node,
                                f"error: option '{dest}' is required")
    return None


def walk(head: str, spec: CLISpec, argv: Sequence[str]) -> WalkResult:
    """Resolve one command line against a CLI tree.

    Each level consumes its own options in POSIX order (stop at the
    first non-option word, which names the subcommand), so
    `git -C <path> status` shapes parse the way a terminal user expects.
    Behavior is pinned to git (docker, git 2.47.3): bare group prints
    its usage to stdout and exits 1, `--help` prints the same to stdout
    and exits 0, an unknown verb refuses on stderr with exit 1, and
    group-level option errors refuse on stderr with exit 129. The leaf's
    own argv is not parsed here; it rides the ordinary spec machinery.

    Args:
        head (str): installed head word, used in every rendering so a
            renamed install prints its own name.
        spec (CLISpec): the root of the tree.
        argv (Sequence[str]): the words after the head.
    """
    node = spec
    path: tuple[str, ...] = ()
    flags: FlagBag = {}
    i = 0
    while True:
        if node.fn is not None:
            return WalkResult(leaf=node,
                              path=path,
                              group_flags=flags,
                              argv=tuple(argv[i:]))
        name = " ".join((head, ) + path)
        cs = compile_spec(node)
        descended = False
        options_ended = False
        while i < len(argv):
            token = argv[i]
            if not options_ended and token == "--help":
                return WalkResult(
                    output=render_group_help(name, node).encode())
            if not options_ended and token == "--":
                options_ended = True
                i += 1
                continue
            if not options_ended and token.startswith("--"):
                spelling, eq, attached = token.partition("=")
                if spelling in cs.long_bool_spellings:
                    if eq:
                        return _usage_error(
                            name, node,
                            f"error: option '{spelling}' takes no value")
                    _record_bool(flags, cs, spelling)
                elif spelling in cs.long_optional_spellings:
                    if eq:
                        _record_value(flags, cs, spelling, attached)
                    else:
                        _record_bool(flags, cs, spelling)
                elif spelling in cs.long_value_spellings:
                    if eq:
                        _record_value(flags, cs, spelling, attached)
                    elif i + 1 < len(argv):
                        i += 1
                        _record_value(flags, cs, spelling, argv[i])
                    else:
                        return _usage_error(
                            name, node,
                            f"error: option '{spelling}' requires a value")
                else:
                    return _usage_error(name, node,
                                        f"unknown option: {spelling}")
                i += 1
                continue
            if not options_ended and token.startswith("-") and token != "-":
                j = 1
                error = None
                while j < len(token):
                    spelling = f"-{token[j]}"
                    if spelling in cs.bool_spellings:
                        _record_bool(flags, cs, spelling)
                        j += 1
                    elif spelling in cs.dest:
                        rest = token[j + 1:]
                        if rest:
                            _record_value(flags, cs, spelling, rest)
                        elif i + 1 < len(argv):
                            i += 1
                            _record_value(flags, cs, spelling, argv[i])
                        else:
                            error = (f"error: option '{spelling}' "
                                     f"requires a value")
                        break
                    else:
                        error = f"unknown option: {spelling}"
                        break
                if error is not None:
                    return _usage_error(name, node, error)
                i += 1
                continue
            refused = _finish_node(name, node, cs, flags)
            if refused is not None:
                return refused
            child = next((c for c in node.subcommands if c.name == token),
                         None)
            if child is None:
                return _unknown_verb(head, name, token)
            node = child
            path = path + (token, )
            i += 1
            descended = True
            break
        if descended:
            continue
        refused = _finish_node(name, node, cs, flags)
        if refused is not None:
            return refused
        return WalkResult(output=render_group_help(name, node).encode(),
                          stream="stdout",
                          exit_code=1)
