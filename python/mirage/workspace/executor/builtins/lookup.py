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


def locations(name: str, session: Session, registry: MountRegistry,
              all_mode: bool) -> list[NameKind]:
    """The kinds to report for one name, honoring an ``-a`` style flag.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
        all_mode (bool): report every layer instead of the winner only.
    """
    if all_mode:
        return classify_all(name, session, registry)
    kind = classify(name, session, registry)
    return [] if kind is None else [kind]


def describe(name: str, kind: NameKind) -> str:
    """Render the verbose line ``command -V`` and ``type`` print.

    Args:
        name (str): the operand word.
        kind (NameKind): the classification.
    """
    return f"{name} is {_DESCRIPTIONS[kind]}"


def _parse_type_flags(
        args: list[str]) -> tuple[str | None, bool, bool, list[str], str
                                  | None]:
    """Split ``type``'s options from its name operands.

    Recognizes ``-t`` (type word only), ``-p``/``-P`` (path; empty for
    mirage's pathless runnables), ``-a`` (every location) and ``-f``
    (skip the function table). Non-permuting like bash: option scanning
    stops at the first non-option word or ``--``.

    Args:
        args (list[str]): words after the ``type`` name.

    Returns:
        ``(mode, all_mode, nofunc, rest, bad)`` where ``mode`` is
        ``"t"``/``"p"``/``None``, ``nofunc`` skips functions, ``rest`` is
        the operands, and ``bad`` is the first invalid option (as
        ``-x``) or ``None``.
    """
    mode: str | None = None
    all_mode = False
    nofunc = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if not (tok.startswith("-") and len(tok) > 1):
            break
        for ch in tok[1:]:
            if ch == "t":
                mode = "t"
            elif ch in ("p", "P"):
                mode = "p"
            elif ch == "a":
                all_mode = True
            elif ch == "f":
                nofunc = True
            else:
                return None, False, False, [], f"-{ch}"
        i += 1
    return mode, all_mode, nofunc, args[i:], None


def _masked_locations(name: str, session: Session, registry: MountRegistry,
                      all_mode: bool, nofunc: bool) -> list[NameKind]:
    """``locations`` with ``type -f``'s function table masked out.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
        all_mode (bool): report every layer instead of the winner only.
        nofunc (bool): hide a shell function of this name for the lookup.
    """
    if not (nofunc and name in session.functions):
        return locations(name, session, registry, all_mode)
    saved = session.functions.pop(name)
    try:
        return locations(name, session, registry, all_mode)
    finally:
        session.functions[name] = saved


def handle_type(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``type`` builtin (``type [-afptP] name [name ...]``).

    Resolution matches ``command -V``, but the exit rule is ``type``'s:
    0 only when every name resolves. ``-t`` prints the classification
    word, ``-p``/``-P`` print a path (always empty here), ``-a`` prints
    one line per layer holding the name (a shell function shadowing an
    installed CLI is the case that has two), and a missing name warns on
    stderr unless a word-only mode (``-t``/``-p``) is active.

    Args:
        args (list[str]): words after the ``type`` name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    mode, all_mode, nofunc, rest, bad = _parse_type_flags(args)
    if bad is not None:
        err = (f"type: {bad}: invalid option\n" + _TYPE_USAGE).encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="type",
                                                         exit_code=2,
                                                         stderr=err)
    out_lines: list[str] = []
    err_lines: list[str] = []
    all_found = True
    for name in rest:
        kinds = _masked_locations(name, session, registry, all_mode, nofunc)
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


def _parse_which_flags(
        args: list[str]) -> tuple[bool, bool, list[str], str | None]:
    """Split ``which``'s options from its name operands.

    debianutils ``which`` takes ``-a`` (every location) and ``-s``
    (status only). Deliberate divergence: ``--`` ends the options here,
    which the C implementation mishandles.

    Args:
        args (list[str]): words after the ``which`` name.

    Returns:
        ``(all_mode, silent, rest, bad)`` where ``bad`` is the first
        invalid option (as ``-x``) or ``None``.
    """
    all_mode = False
    silent = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if not (tok.startswith("-") and len(tok) > 1):
            break
        for ch in tok[1:]:
            if ch == "a":
                all_mode = True
            elif ch == "s":
                silent = True
            else:
                return False, False, [], f"-{ch}"
        i += 1
    return all_mode, silent, args[i:], None


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
    names the layers.

    Args:
        args (list[str]): words after the ``which`` name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    all_mode, silent, rest, bad = _parse_which_flags(args)
    if bad is not None:
        err = (f"which: {bad}: invalid option\n" + _WHICH_USAGE).encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="which",
                                                         exit_code=2,
                                                         stderr=err)
    out_lines: list[str] = []
    all_found = True
    for name in rest:
        kinds = [
            kind for kind in locations(name, session, registry, all_mode)
            if kind is not NameKind.KEYWORD
        ]
        if not kinds:
            all_found = False
            continue
        if not silent:
            out_lines.extend(name for _ in kinds)
    out = ("\n".join(out_lines) + "\n").encode() if out_lines else None
    code = 0 if (rest and all_found) else 1
    return out, IOResult(exit_code=code), ExecutionNode(command="which",
                                                        exit_code=code)
