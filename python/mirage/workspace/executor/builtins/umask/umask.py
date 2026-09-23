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
from mirage.utils.mode import parse_chmod
from mirage.workspace.executor.builtins.getopt import scan_options
from mirage.workspace.executor.builtins.shared import fail
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode

_USAGE = "umask: usage: umask [-p] [-S] [mode]"


def symbolic_umask(mask: int) -> str:
    """Render a mask the way `umask -S` does: the bits it *leaves on*.

    Args:
        mask (int): the umask.
    """
    perms = 0o777 & ~mask
    parts = []
    for who, shift in (("u", 6), ("g", 3), ("o", 0)):
        bits = (perms >> shift) & 0o7
        letters = ("r" if bits & 4 else "") + ("w" if bits & 2 else
                                               "") + ("x" if bits & 1 else "")
        parts.append(f"{who}={letters}")
    return ",".join(parts)


def parse_umask(text: str, current: int) -> int | str:
    """The mask a `umask` operand names, or the error bash prints for it.

    An all-digit operand is octal, refused with `octal number out of
    range` when it holds an 8 or a 9 (`umask 999`, `umask 8`) and
    clamped to 0777 when it is octal but too large; anything else
    is a symbolic clause list applied to the *permissions* the current
    mask leaves on, so `umask u=rwx,g=,o=` yields 0077 and `umask g+w`
    on 0022 yields 0002. bash's two symbolic refusals are told apart:
    a letter outside `ugoa` where an operator was expected is
    `invalid symbolic mode operator`, and one outside `rwx` after the
    operator is `invalid symbolic mode character`, both quoted with the
    offending character.

    Args:
        text (str): the operand as typed.
        current (int): the mask in force.
    """
    if text.isdigit():
        if not all(c in "01234567" for c in text):
            return f"bash: umask: {text}: octal number out of range\n"
        # bash 5.2 clamps an octal value past 0777 to 0777 (`umask 07777`
        # and `umask 1000` both leave 0777) rather than refusing it; only
        # a non-octal digit is out of range.
        return min(int(text, 8), 0o777)
    perms = 0o777 & ~current
    for clause in text.split(","):
        i = 0
        while i < len(clause) and clause[i] in "ugoa":
            i += 1
        if i >= len(clause) or clause[i] not in "+-=":
            bad = clause[i] if i < len(clause) else ""
            return (f"bash: umask: `{bad}': invalid symbolic mode "
                    "operator\n")
        for ch in clause[i + 1:]:
            if ch not in "+-=rwx":
                return (f"bash: umask: `{ch}': invalid symbolic mode "
                        "character\n")
    parsed = parse_chmod(text, perms)
    if parsed is None:
        return f"bash: umask: `{text}': invalid symbolic mode character\n"
    return 0o777 & ~parsed


async def handle_umask(
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print or set the session's file-creation mask.

    With no operand the mask prints as four octal digits (`0022`), as
    a symbolic permission list under `-S` (`u=rwx,g=rx,o=rx`), and as a
    re-readable `umask 0022` line under `-p`. With one it is set for
    the rest of the shell; a subshell gets its own copy and puts the
    parent's back, a function does not. Extra operands are ignored, as
    bash ignores them. An unknown option is exit 2 with the usage line,
    a bad mode exit 1 with the mask unchanged.

    Args:
        args (list[str]): the words after `umask`.
        session (SessionState): shell session state.
    """
    scan = scan_options(args, "Sp")
    if scan.bad is not None:
        return fail("umask",
                    f"bash: umask: {scan.bad}: invalid option\n{_USAGE}\n", 2)
    symbolic = "S" in scan.letters
    reusable = "p" in scan.letters
    operands = scan.operands
    if not operands:
        body = (symbolic_umask(session.umask)
                if symbolic else f"{session.umask:04o}")
        if reusable:
            body = f"umask {'-S ' if symbolic else ''}{body}"
        return (body + "\n").encode(), IOResult(), ExecutionNode(
            command="umask", exit_code=0)
    parsed = parse_umask(operands[0], session.umask)
    if isinstance(parsed, str):
        return fail("umask", parsed, 1)
    session.umask = parsed
    return None, IOResult(), ExecutionNode(command="umask", exit_code=0)


async def umask_builtin(call: BuiltinCall) -> Result:
    """The ``umask`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_umask(list(call.argv.args), call.session)
