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

from enum import StrEnum

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.mount import MountRegistry
from mirage.workspace.route import Consumer, route, route_all
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_TYPE_USAGE = "type: usage: type [-afptP] name [name ...]\n"
_WHICH_USAGE = "which: usage: which [-as] name [name ...]\n"

# bash reserved words: reported by `command -v/-V` and `type` as
# keywords even though the parser, not the executor, consumes them.
KEYWORDS = frozenset({
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "select",
    "while",
    "until",
    "do",
    "done",
    "in",
    "function",
    "time",
    "coproc",
    "{",
    "}",
    "!",
    "[[",
    "]]",
})


class NameKind(StrEnum):
    """What a command name resolves to, spelled as ``type -t`` prints it.

    bash's ``-t`` vocabulary is alias/keyword/function/builtin/file.
    mirage has no aliases and no external binaries, so ``file`` never
    applies and every mirage-native runnable name that is not a function
    would collapse into ``builtin``. ``cli`` is a sixth word rather than
    a reuse of ``file``: reusing it would promise ``type -p`` a path to
    print, and there is none.
    """
    KEYWORD = "keyword"
    FUNCTION = "function"
    CLI = "cli"
    BUILTIN = "builtin"


# Shell builtins, namespace commands and mount commands are all
# in-process and pathless, so they share bash's runnable-and-in-process
# category. That collapse is deliberate; `cli` is kept apart because an
# installed CLI is the one runnable an agent cannot otherwise discover.
_KIND_BY_CONSUMER: dict[Consumer, NameKind] = {
    Consumer.SESSION: NameKind.BUILTIN,
    Consumer.NAMESPACE: NameKind.BUILTIN,
    Consumer.FUNCTION: NameKind.FUNCTION,
    Consumer.CLI: NameKind.CLI,
    Consumer.MOUNT: NameKind.BUILTIN,
}

_DESCRIPTIONS: dict[NameKind, str] = {
    NameKind.KEYWORD: "a shell keyword",
    NameKind.FUNCTION: "a function",
    NameKind.CLI: "a mirage CLI",
    NameKind.BUILTIN: "a shell builtin",
}


def classify(name: str, session: Session,
             registry: MountRegistry) -> NameKind | None:
    """Classify the name as the layer that would run it, None if none does.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    if name in KEYWORDS:
        return NameKind.KEYWORD
    return _KIND_BY_CONSUMER.get(route(name, session, registry))


def classify_all(name: str, session: Session,
                 registry: MountRegistry) -> list[NameKind]:
    """Classify every layer holding the name, most-preferred first.

    Duplicate kinds are dropped, since the kinds are coarser than the
    layers: a shell builtin that a mount also registers is one
    ``builtin`` line, not two identical ones.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    if name in KEYWORDS:
        return [NameKind.KEYWORD]
    kinds: list[NameKind] = []
    for consumer in route_all(name, session, registry):
        kind = _KIND_BY_CONSUMER[consumer]
        if kind not in kinds:
            kinds.append(kind)
    return kinds


def _locations(name: str,
               session: Session,
               registry: MountRegistry,
               all_mode: bool,
               nofunc: bool = False) -> list[NameKind]:
    """The kinds to report for one name, honoring ``-a`` and ``-f``.

    Both flags are filters over the layer list, never edits to the
    session: ``-f`` drops the function layer so the layer below it is
    what remains, and ``-a`` keeps them all instead of the winner only.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
        all_mode (bool): report every layer instead of the winner only.
        nofunc (bool): ignore a shell function of this name.
    """
    kinds = classify_all(name, session, registry)
    if nofunc:
        kinds = [kind for kind in kinds if kind is not NameKind.FUNCTION]
    return kinds if all_mode else kinds[:1]


def describe(name: str, kind: NameKind) -> str:
    """Render the verbose line ``command -V`` and ``type`` print.

    Args:
        name (str): the operand word.
        kind (NameKind): the classification.
    """
    return f"{name} is {_DESCRIPTIONS[kind]}"


def handle_type(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``type`` builtin (``type [-afptP] name [name ...]``).

    Resolution matches ``command -V``, but the exit rule is ``type``'s:
    0 only when every name resolves. ``-t`` prints the classification
    word, ``-p``/``-P`` print a path (always empty here) and are one
    mutually exclusive group with ``-t``, ``-a`` prints one line per
    layer holding the name (a shell function shadowing an installed CLI
    is the case that has two), ``-f`` ignores the function table, and a
    missing name warns on stderr unless a word-only mode (``-t``/``-p``)
    is active.

    Args:
        args (list[str]): words after the ``type`` name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    scan = scan_options(args, "afptP")
    if scan.bad is not None:
        err = (f"type: {scan.bad}: invalid option\n" + _TYPE_USAGE).encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="type",
                                                         exit_code=2,
                                                         stderr=err)
    last = last_of(scan.letters, "tpP")
    mode = last if last is None or last == "t" else "p"
    all_mode = "a" in scan.letters
    nofunc = "f" in scan.letters
    rest = scan.operands
    out_lines: list[str] = []
    err_lines: list[str] = []
    all_found = True
    for name in rest:
        kinds = _locations(name, session, registry, all_mode, nofunc)
        if not kinds:
            all_found = False
            if mode is None:
                err_lines.append(f"type: {name}: not found")
            continue
        if mode == "t":
            out_lines.extend(kind.value for kind in kinds)
        elif mode is None:
            out_lines.extend(describe(name, kind) for kind in kinds)
    out = ("\n".join(out_lines) + "\n").encode() if out_lines else None
    err = ("\n".join(err_lines) + "\n").encode() if err_lines else b""
    code = 0 if (not rest or all_found) else 1
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="type",
                                                    exit_code=code,
                                                    stderr=err)


def handle_which(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``which`` builtin (``which [-as] name [name ...]``).

    Pinned against debianutils ``which`` (debian:stable-slim): a miss
    prints nothing at all, the exit status is 0 only when every name
    resolves (1 with no operands), and ``-s`` reports through the status
    alone. Two deliberate divergences, both forced by mirage having no
    PATH: the printed word is the name rather than a path (as
    ``command -v`` already does), and every runnable resolves, where GNU
    reports only files (``which cd`` misses there, since a builtin is
    not on the PATH; here everything is in-process, so reporting nothing
    would make the command useless). Keywords stay unresolvable, as they
    are not commands anywhere. ``-a`` prints one line per layer, so a
    shadowed name prints its name twice; ``type -a`` is the surface that
    names the layers. The refusal for an unknown option is bash's shape,
    not the C tool's ``Illegal option``, because this is a builtin and
    the usage line cannot honestly name ``/usr/bin/which``.

    Args:
        args (list[str]): words after the ``which`` name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    scan = scan_options(args, "as")
    if scan.bad is not None:
        err = (f"which: {scan.bad}: invalid option\n" + _WHICH_USAGE).encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="which",
                                                         exit_code=2,
                                                         stderr=err)
    all_mode = "a" in scan.letters
    silent = "s" in scan.letters
    rest = scan.operands
    out_lines: list[str] = []
    all_found = True
    for name in rest:
        kinds = [
            kind for kind in _locations(name, session, registry, all_mode)
            if kind is not NameKind.KEYWORD
        ]
        if not kinds:
            all_found = False
            continue
        if not silent:
            out_lines.extend([name] * len(kinds))
    out = ("\n".join(out_lines) + "\n").encode() if out_lines else None
    code = 0 if (rest and all_found) else 1
    return out, IOResult(exit_code=code), ExecutionNode(command="which",
                                                        exit_code=code)
