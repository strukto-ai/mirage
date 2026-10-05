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

from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.executor.builtins.lookup.classify import (
    describe,
    locations,
    program_file,
)
from mirage.workspace.executor.builtins.lookup.constants import (
    TYPE_OPTIONS,
    TYPE_USAGE,
    WHICH_OPTIONS,
    WHICH_USAGE,
)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.executor.builtins.shared import result
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.lookup import program
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState


def handle_type(
    args: list[str],
    session: SessionState,
    registry: MountRegistry,
) -> Result:
    """Run the ``type`` builtin (``type [-afptP] name [name ...]``).

    Resolution matches ``command -V``, but the exit rule is ``type``'s:
    0 only when every name resolves. ``-t`` prints the classification
    word; ``-p`` prints the file of a name that resolves to one (none
    for a builtin, which still resolves) and ``-P`` searches PATH for
    one even past a builtin, a miss there being a miss; the three are
    one group, the last winning. ``-a`` prints one line per layer
    holding the name (a builtin that is also a program ends with its
    file's line), ``-f`` ignores the function table, and a missing name
    warns on stderr unless a word-only mode (``-t``/``-p``/``-P``) is
    active. Pinned against bash 5.2 on debian:stable-slim.

    Args:
        args (list[str]): words after the ``type`` name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    scan = scan_options(args, TYPE_OPTIONS)
    if scan.bad is not None:
        return result(
            "type",
            exit_code=2,
            stderr=f"bash: type: {scan.bad}: invalid option\n{TYPE_USAGE}",
        )
    mode = last_of(scan.letters, "tpP")
    all_mode = "a" in scan.letters
    hidden = NameKind.FUNCTION if "f" in scan.letters else None
    out_lines: list[str] = []
    err_lines: list[str] = []
    all_found = True
    for name in scan.operands:
        if mode == "P":
            if program(name, session, registry) is None:
                all_found = False
            else:
                out_lines.append(f"{program_file(name)}\n")
            continue
        kinds = locations(name, session, registry, all_mode, hidden)
        if not kinds:
            all_found = False
            if mode is None:
                err_lines.append(f"bash: type: {name}: not found\n")
            continue
        if mode == "t":
            out_lines.extend(f"{kind.value}\n" for kind in kinds)
        elif mode == "p":
            out_lines.extend(
                f"{program_file(name)}\n"
                for kind in kinds
                if kind is NameKind.FILE
            )
        else:
            out_lines.extend(
                f"{describe(name, kind, session)}\n" for kind in kinds
            )
    out = encode_text("".join(out_lines)) if out_lines else None
    # One call, so the diagnostics never ride on the status: a partial
    # miss both warns and reports through the exit code.
    code = 0 if (not scan.operands or all_found) else 1
    return result("type", out=out, exit_code=code, stderr="".join(err_lines))


def handle_which(
    args: list[str],
    session: SessionState,
    registry: MountRegistry,
) -> Result:
    """Run the ``which`` builtin (``which [-as] name [name ...]``).

    Pinned against debianutils ``which`` (debian:stable-slim): it prints
    the file PATH finds for each name, which is the program's under
    ``/usr/bin`` (the one PATH directory), a miss prints nothing at all,
    the exit status is 0 only when every name resolves (1 with no
    operands), and ``-s`` reports through the status alone. A builtin
    with no program (``cd``), a function, an alias and a reserved word
    are no file, so each is a miss; ``-a`` has one directory to search
    and so one line per name. ``$PATH`` itself is not read: mirage runs
    a program by its name whatever PATH holds, so ``which`` answers as
    dispatch does. The refusal for an unknown option is bash's shape,
    not the C tool's ``Illegal option``, because this is a builtin.

    Args:
        args (list[str]): words after the ``which`` name.
        session (SessionState): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    scan = scan_options(args, WHICH_OPTIONS)
    if scan.bad is not None:
        return result(
            "which",
            exit_code=2,
            stderr=f"which: {scan.bad}: invalid option\n{WHICH_USAGE}",
        )
    silent = "s" in scan.letters
    out_lines: list[str] = []
    all_found = True
    for name in scan.operands:
        if program(name, session, registry) is None:
            all_found = False
            continue
        if not silent:
            out_lines.append(f"{program_file(name)}\n")
    out = encode_text("".join(out_lines)) if out_lines else None
    code = 0 if (scan.operands and all_found) else 1
    return result("which", out=out, exit_code=code)


async def type_builtin(call: BuiltinCall) -> Result:
    """The ``type`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return handle_type(list(call.argv.args), call.session, call.registry)


async def which_builtin(call: BuiltinCall) -> Result:
    """The ``which`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return handle_which(list(call.argv.args), call.session, call.registry)
