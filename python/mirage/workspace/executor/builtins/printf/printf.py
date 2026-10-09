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

import re

from mirage.commands.quote import quote_text
from mirage.commands.spec.usage import usage_hint
from mirage.context import program_invocation
from mirage.io import IOResult
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource
from mirage.policy import PolicyDenied
from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.errors import ArithError
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.printf.format import run_printf
from mirage.workspace.executor.builtins.shared import fail, result
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import env_snapshot, session_view
from mirage.workspace.types import ExecutionNode

# bash 5.2.21's own string, which both the usage error and the
# invalid-option refusal end with.
_USAGE = "printf: usage: printf [-v var] format [arguments]\n"

# bash's own help page for the printf builtin, byte for byte as bash
# 5.2.37 writes it, because `printf --help` is answered by the builtin
# and a builtin's page is bash's, not GNU coreutils'. It cannot come
# from render_help: the page documents `-v`, which is the BUILTIN's
# option alone (run as a program through `find -exec printf`, `-v` is
# not available), so CommandSpec must not declare it and the spec-driven
# renderer has nothing to render it from.
#
# One deliberate divergence, and it is a subtraction: bash lists `%Q` and
# `%(fmt)T` among the conversions it adds to printf(1), and mirage
# implements neither, so those two entries are dropped rather than
# promised. Everything mirage does implement is described in bash's own
# words. Adding either conversion means adding its lines back here.
_HELP = (
    "printf: printf [-v var] format [arguments]\n"
    "    Formats and prints ARGUMENTS under control of the FORMAT.\n"
    "    \n"
    "    Options:\n"
    "      -v var\tassign the output to shell variable VAR rather than\n"
    "    \t\tdisplay it on the standard output\n"
    "    \n"
    "    FORMAT is a character string which contains three types of objects:"
    " plain\n"
    "    characters, which are simply copied to standard output; character"
    " escape\n"
    "    sequences, which are converted and copied to the standard output;"
    " and\n"
    "    format specifications, each of which causes printing of the next"
    " successive\n"
    "    argument.\n"
    "    \n"
    "    In addition to the standard format specifications described in"
    " printf(1),\n"
    "    printf interprets:\n"
    "    \n"
    "      %b\texpand backslash escape sequences in the corresponding"
    " argument\n"
    "      %q\tquote the argument in a way that can be reused as shell"
    " input\n"
    "    \n"
    "    The format is re-used as necessary to consume all of the arguments."
    "  If\n"
    "    there are fewer arguments than the format requires,  extra format\n"
    "    specifications behave as if a zero value or null string, as"
    " appropriate,\n"
    "    had been supplied.\n"
    "    \n"
    "    Exit Status:\n"
    "    Returns success unless an invalid option is given or a write or"
    " assignment\n"
    "    error occurs.\n"
)


async def handle_printf(
    args: list[str],
    session: SessionState,
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print formatted output, honoring GNU printf's format-reuse rules.

    Supports ``%s %c %b %q``, the integer conversions ``%d %i %o %u %x
    %X``, the float conversions ``%f %F %e %E %g %G %a %A``, and ``%%``,
    with ``- + 0 # (space)`` flags, numeric or ``*`` width/precision, and
    backslash escapes (including ``\\u``/``\\U``) interpreted once in the
    same scan. When arguments remain after one pass the format is reused
    until they are exhausted; a missing argument renders as the empty
    string / ``0``. Integers wrap at 64 bits; ``%a`` formats at IEEE
    double precision. The conversion engine itself lives in
    ``printf_format``.

    With ``-v NAME`` the formatted text is stored in the shell variable
    ``NAME`` (or the array element ``NAME[idx]``) instead of written to
    stdout, matching bash's builtin. An unusable ``NAME`` is rejected
    before the format runs (status 2); a readonly name or an
    out-of-range subscript still reports the format's own errors first,
    then fails with status 1 and leaves the variable untouched. bash
    stores the bytes the format produced, so a ``\\x`` run that is valid
    UTF-8 is stored as its characters, and up to the first NUL, which no
    variable holds (``printf -v n '1\\0002'`` stores 1). ``-v`` is the
    builtin's alone: run as a program (``find -exec printf``, which
    execvp answers with coreutils printf) the word is the format, and a
    format that takes no argument warns about the ones it drops.

    Args:
        args (list[str]): the format followed by its arguments, optionally
            preceded by ``-v NAME``.
        session (SessionState): shell session, for the ``-v`` assignment.
        view (SessionView | None): the session view the ``-v`` write
            goes through, so a ``pre_session`` refusal is reported in the
            rule's own words; None outside a workspace.
    """
    program = program_invocation(session)
    target: str | None = None
    parsed: re.Match[str] | None = None
    if len(args) >= 2 and args[0] == "-v" and not program:
        target = args[1]
        args = args[2:]
        parsed = TARGET_RE.match(target)
        if parsed is None:
            # bash validates the name before formatting, so a bad name
            # suppresses the conversion errors the format would report.
            return fail(
                "printf",
                f"bash: printf: `{target}': not a valid identifier\n",
                2,
            )
    if args and not program:
        first = args[0]
        if first == "--":
            args = args[1:]
            if not args:
                # `--` ends the options and the FORMAT is still
                # required, so the line is bash's usage error rather
                # than an empty one (bash 5.2.21: `printf --` is exit 2
                # with the usage, where `printf -- --zzz` prints
                # `--zzz`).
                return fail("printf", _USAGE, 2)
        elif first == "--help":
            # bash answers the EXACT word `--help` for every builtin,
            # ahead of its option scan, by writing the builtin's help
            # page to STDOUT and exiting 2 -- only a spelling
            # the option scan actually reads (`--hel`, `--version`)
            # takes the invalid-option path below (bash 5.2.37). The
            # page is the BUILTIN's, in bash's own words and layout,
            # because that is whose printf this is; see _HELP.
            return (
                yield_bytes(encode_text(_HELP)),
                IOResult(exit_code=2),
                ExecutionNode(command="printf", exit_code=2),
            )
        elif first.startswith("-") and len(first) > 1 and first != "-v":
            # bash's option scan takes single letters only, so it
            # reports the first character it does not know spelled with
            # ONE dash: a long spelling answers for its second dash and
            # its text never reaches the message, which is why
            # `printf --zzz`, `printf --hel` and `printf --zzz=é` are all
            # `printf: --: invalid option` (bash 5.2.21). The coreutils
            # binary is lenient here and prints the word, but mirage
            # ships printf as a builtin, so the builtin governs. A bare
            # `-v` short of its NAME is left to the format path, where
            # bash's own `option requires an argument` is a separate
            # change.
            return fail(
                "printf",
                f"bash: printf: -{first[1]}: invalid option\n{_USAGE}",
                2,
            )
    elif args and args[0] == "--":
        # coreutils printf takes one leading `--` as the end of its
        # options.
        args = args[1:]
    if not args:
        # A format is required: bash's usage error, `printf -v x` too.
        if program:
            return fail(
                "printf", f"printf: missing operand\n{usage_hint('printf')}\n"
            )
        return fail("printf", _USAGE, 2)
    output, messages, failed, excess = run_printf(
        args[0],
        args[1:],
        program,
        program and "POSIXLY_CORRECT" in env_snapshot(session),
    )
    errors = "".join(
        ("" if program else "bash: ") + message for message in messages
    )
    exit_code = 1 if failed else 0
    if target is not None and parsed is not None:
        base, subscript = parsed.group(1), parsed.group(2)
        text = decode_text(encode_text(output)).partition("\0")[0]
        try:
            status = await assign_element(session, view, base, subscript, text)
        except PolicyDenied as exc:
            return fail("printf", errors + f"bash: {exc.strerror}\n")
        except ArithError as exc:
            # The target carries `-i` and the formatted text does not
            # evaluate, which ends the shell as any `-i` value does.
            signal = exc.signal("printf", fatal=True)
            signal.stderr = encode_text(errors) + signal.stderr
            raise signal from exc
        if status == "readonly":
            return fail(
                "printf", errors + f"bash: {base}: readonly variable\n"
            )
        if status == "denied":
            return fail(
                "printf", errors + f"bash: {base}: permission denied\n"
            )
        if status != "ok":
            return fail(
                "printf", errors + f"bash: {target}: bad array subscript\n"
            )
        return result("printf", exit_code=exit_code, stderr=errors)
    if excess is not None and program:
        # coreutils printf names the first argument a format that takes
        # none left over, where bash's builtin drops them silently; a
        # warning, so the status stays the format's own.
        errors += (
            "printf: warning: ignoring excess arguments, "
            f"starting with '{quote_text(excess)}'\n"
        )
    return result("printf", encode_text(output), exit_code, errors)


async def printf_builtin(call: BuiltinCall) -> Result:
    """The ``printf`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_printf(
        list(call.argv.args),
        call.context.session,
        session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
    )
