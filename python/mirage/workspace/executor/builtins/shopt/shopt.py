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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.constants import (SET_OPTION_DEFAULTS, SET_OPTION_NAMES,
                                    SHOPT_DEFAULTS, SHOPT_UNSUPPORTED)
from mirage.workspace.executor.builtins.getopt import last_of, scan_options
from mirage.workspace.executor.builtins.shared import fail
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

_USAGE = "shopt: usage: shopt [-pqsu] [-o] [optname ...]"


def shopt_enabled(session: SessionState, name: str) -> bool:
    """Whether a `shopt` option is on for the session.

    Args:
        session (SessionState): the session holding the option table.
        name (str): the option's `shopt` spelling.
    """
    return session.shopts.get(name, SHOPT_DEFAULTS[name])


def _row(name: str, on: bool, reusable: bool, set_o: bool) -> str:
    """One listing line in bash's two shapes.

    `%-15s\\t%s` for the plain listing (a longer name simply overflows
    the padding, as GNU's own format string does), and a line a script
    can feed back for `-p`: `shopt -s NAME` for a shopt option, `set -o
    NAME` for one reached through `-o`.

    Args:
        name (str): the option.
        on (bool): its state.
        reusable (bool): render the `-p` shape.
        set_o (bool): the option is a `set -o` one.
    """
    if reusable:
        if set_o:
            return f"set {'-' if on else '+'}o {name}"
        return f"shopt -{'s' if on else 'u'} {name}"
    return f"{name:<15}\t{'on' if on else 'off'}"


async def handle_shopt(
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Set, unset, print or query the `shopt` options.

    bash's grammar, pinned on 5.2.37: bare `shopt` lists every option
    with its state, `-p` prints them as re-readable `shopt -s/-u NAME`
    lines, `-s`/`-u` with names set or clear and without names list the
    ones that are on or off, `-q` prints nothing and answers 0 only when
    every named option is on, and `-o` moves all of that onto the
    `set -o` vocabulary. Naming an option prints it and answers 1 when
    any is off. An unknown name is `invalid shell option name` (or
    `invalid option name` under `-o`), exit 1, and the other names still
    apply; `-s` with `-u` is refused before anything applies; an
    unknown letter is exit 2 with the usage line.

    One deliberate refusal: `shopt -s extglob` exits 1 with a mirage
    message, because the parser has no extglob mode and storing `on`
    would promise a syntax that still fails to parse.

    Args:
        args (list[str]): the words after `shopt`.
        session (SessionState): shell session state.
    """
    scan = scan_options(args, "pqosu")
    if scan.bad is not None:
        return fail("shopt",
                    f"bash: shopt: {scan.bad}: invalid option\n{_USAGE}\n", 2)
    if "s" in scan.letters and "u" in scan.letters:
        return fail(
            "shopt", "bash: shopt: cannot set and unset shell options "
            "simultaneously\n", 1)
    reusable = "p" in scan.letters
    quiet = "q" in scan.letters
    set_o = "o" in scan.letters
    chosen = last_of(scan.letters, "su")
    setting = None if chosen is None else chosen == "s"
    names = scan.operands
    table = SET_OPTION_DEFAULTS if set_o else SHOPT_DEFAULTS
    store = session.shell_options if set_o else session.shopts
    lines: list[str] = []
    errors: list[str] = []
    status = 0
    if not names:
        # `-s`/`-u` alone list the options in that state; a bare call
        # (or `-p`/`-q` alone) lists them all, quietly under `-q`.
        for name in table:
            on = store.get(name, table[name])
            if setting is not None and on != setting:
                continue
            if not quiet:
                lines.append(_row(name, on, reusable, set_o))
        out = ("\n".join(lines) + "\n").encode() if lines else None
        return out, IOResult(), ExecutionNode(command="shopt", exit_code=0)
    for name in names:
        if name not in table or (set_o and name not in SET_OPTION_NAMES):
            kind = "option name" if set_o else "shell option name"
            errors.append(f"bash: shopt: {name}: invalid {kind}")
            status = 1
            continue
        if setting is None:
            on = store.get(name, table[name])
            if not on:
                status = 1
            if not quiet:
                lines.append(_row(name, on, reusable, set_o))
            continue
        if setting and not set_o and name in SHOPT_UNSUPPORTED:
            errors.append(f"mirage: shopt: {name}: not supported")
            status = 1
            continue
        store[name] = setting
    out = ("\n".join(lines) + "\n").encode() if lines else None
    err = ("\n".join(errors) + "\n").encode() if errors else None
    return out, IOResult(exit_code=status, stderr=err
                         or b""), ExecutionNode(command="shopt",
                                                exit_code=status,
                                                stderr=err or b"")


async def shopt_builtin(call: BuiltinCall) -> Result:
    """The ``shopt`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_shopt(list(call.argv.args), call.session)
