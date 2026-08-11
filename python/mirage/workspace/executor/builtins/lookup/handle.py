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

from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.executor.builtins.lookup.classify import (describe,
                                                                locations)
from mirage.workspace.executor.builtins.lookup.constants import (TYPE_OPTIONS,
                                                                 TYPE_USAGE,
                                                                 WHICH_OPTIONS,
                                                                 WHICH_USAGE)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.executor.builtins.shared import Result, result
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session


def handle_type(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> Result:
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
    scan = scan_options(args, TYPE_OPTIONS)
    if scan.bad is not None:
        return result("type",
                      exit_code=2,
                      stderr=f"type: {scan.bad}: invalid option\n{TYPE_USAGE}")
    last = last_of(scan.letters, "tpP")
    mode = last if last is None or last == "t" else "p"
    all_mode = "a" in scan.letters
    hidden = NameKind.FUNCTION if "f" in scan.letters else None
    out_lines: list[str] = []
    err_lines: list[str] = []
    all_found = True
    for name in scan.operands:
        kinds = locations(name, session, registry, all_mode, hidden)
        if not kinds:
            all_found = False
            if mode is None:
                err_lines.append(f"type: {name}: not found\n")
            continue
        if mode == "t":
            out_lines.extend(f"{kind.value}\n" for kind in kinds)
        elif mode is None:
            out_lines.extend(f"{describe(name, kind)}\n" for kind in kinds)
    out = "".join(out_lines).encode() if out_lines else None
    # One call, so the diagnostics never ride on the status: a partial
    # miss both warns and reports through the exit code.
    code = 0 if (not scan.operands or all_found) else 1
    return result("type", out=out, exit_code=code, stderr="".join(err_lines))


def handle_which(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> Result:
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
    scan = scan_options(args, WHICH_OPTIONS)
    if scan.bad is not None:
        return result(
            "which",
            exit_code=2,
            stderr=f"which: {scan.bad}: invalid option\n{WHICH_USAGE}")
    all_mode = "a" in scan.letters
    silent = "s" in scan.letters
    out_lines: list[str] = []
    all_found = True
    for name in scan.operands:
        kinds = locations(name, session, registry, all_mode, NameKind.KEYWORD)
        if not kinds:
            all_found = False
            continue
        if not silent:
            out_lines.extend([f"{name}\n"] * len(kinds))
    out = "".join(out_lines).encode() if out_lines else None
    code = 0 if (scan.operands and all_found) else 1
    return result("which", out=out, exit_code=code)
