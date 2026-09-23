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

from mirage.context import program_invocation
from mirage.io import IOResult
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource
from mirage.ops.types import SessionView
from mirage.policy import PolicyDenied
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ArithError
from mirage.workspace.executor.builtins.constants import TARGET_RE
from mirage.workspace.executor.builtins.printf.format import run_printf
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.elements import assign_element
from mirage.workspace.session.state import session_view
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
    "    error occurs.\n")


async def _assign_printf_target(session: SessionState,
                                view: SessionView | None, name: str,
                                subscript: str | None, value: str) -> str:
    """Assign ``value`` to a ``printf -v`` target (scalar or ``name[idx]``).

    A delegation to the one element writer: a bare name assigns element
    0 when the name already holds an array (indexed or associative),
    nothing mutates unless the whole assignment succeeds, and the
    landing write goes through the door as the whole variable, so a
    ``pre_session`` rule refusing the name sees `printf -v 'AWS_KEY[0]'`
    as a write to AWS_KEY. The refusal is raised, not collapsed into a
    status, so the rule's own words reach the user as they do from
    ``export``.

    Args:
        session (SessionState): shell session whose variables are written.
        view (SessionView | None): the session plane's door, which the
            write clears; None outside a workspace.
        name (str): the target's base variable name.
        subscript (str | None): the ``[...]`` text, or None for a scalar.
        value (str): the formatted text to store.

    Returns:
        str: ``"ok"``, ``"denied"``, ``"readonly"``, or ``"subscript"``.

    Raises:
        PolicyDenied: a pre_session rule refused the write; the caller
            renders the rule's own message.
    """
    return await assign_element(session, view, name, subscript, value)


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
    then fails with status 1 and leaves the variable untouched. ``-v``
    is the builtin's alone: run as a program (``find -exec printf``,
    which execvp answers with coreutils printf) the word is the format.

    Args:
        args (list[str]): the format followed by its arguments, optionally
            preceded by ``-v NAME``.
        session (SessionState): shell session, for the ``-v`` assignment.
    """
    target: str | None = None
    parsed: re.Match[str] | None = None
    if len(args) >= 2 and args[0] == "-v" and not program_invocation(session):
        target = args[1]
        args = args[2:]
        parsed = TARGET_RE.match(target)
        if parsed is None:
            # bash validates the name before formatting, so a bad name
            # suppresses the conversion errors the format would report.
            err = f"printf: `{target}': not a valid identifier\n".encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="printf",
                                                             exit_code=2,
                                                             stderr=err)
    if args and not program_invocation(session):
        first = args[0]
        if first == "--":
            args = args[1:]
            if not args:
                # `--` ends the options and the FORMAT is still
                # required, so the line is bash's usage error rather
                # than an empty one (bash 5.2.21: `printf --` is exit 2
                # with the usage, where `printf -- --zzz` prints
                # `--zzz`).
                err = _USAGE.encode()
                return None, IOResult(exit_code=2, stderr=err), ExecutionNode(
                    command="printf", exit_code=2, stderr=err)
        elif first == "--help":
            # bash answers the EXACT word `--help` for every builtin,
            # ahead of `internal_getopt`, by writing the builtin's help
            # page to STDOUT and exiting 2 -- only a spelling
            # internal_getopt actually reads (`--hel`, `--version`)
            # takes the invalid-option path below (bash 5.2.37). The
            # page is the BUILTIN's, in bash's own words and layout,
            # because that is whose printf this is; see _HELP.
            page = _HELP.encode()
            return yield_bytes(page), IOResult(exit_code=2), ExecutionNode(
                command="printf", exit_code=2)
        elif first.startswith("-") and len(first) > 1 and first != "-v":
            # bash's `internal_getopt` takes single letters only, so it
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
            err = f"printf: -{first[1]}: invalid option\n{_USAGE}".encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="printf",
                                                             exit_code=2,
                                                             stderr=err)
    if not args:
        if target is not None:
            # `printf -v x` with no format is a usage error in bash.
            err = _USAGE.encode()
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="printf",
                                                             exit_code=2)
        return b"", IOResult(), ExecutionNode(command="printf", exit_code=0)
    output, errors = run_printf(args[0], args[1:])
    err_bytes = "".join(errors).encode() if errors else b""
    if target is not None and parsed is not None:
        base, subscript = parsed.group(1), parsed.group(2)
        try:
            status = await _assign_printf_target(session, view, base,
                                                 subscript, output)
        except PolicyDenied as exc:
            err_bytes += f"bash: {exc.strerror}\n".encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        except ArithError as exc:
            # The target carries `-i` and the formatted text does not
            # evaluate; bash voices the evaluator after the text.
            err_bytes += f"bash: printf: {exc}\n".encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        if status != "ok":
            if status == "readonly":
                refusal = f"bash: {base}: readonly variable\n"
            elif status == "denied":
                refusal = f"bash: {base}: permission denied\n"
            else:
                refusal = f"bash: {target}: bad array subscript\n"
            err_bytes += refusal.encode()
            return None, IOResult(
                exit_code=1, stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
        exit_code = 1 if errors else 0
        return None, IOResult(exit_code=exit_code, stderr=err_bytes
                              or None), ExecutionNode(command="printf",
                                                      exit_code=exit_code)
    out = encode_text(output)
    if errors:
        return out, IOResult(exit_code=1,
                             stderr=err_bytes), ExecutionNode(command="printf",
                                                              exit_code=1,
                                                              stderr=err_bytes)
    return out, IOResult(), ExecutionNode(command="printf", exit_code=0)


async def printf_builtin(call: BuiltinCall) -> Result:
    """The ``printf`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_printf(
        list(call.argv.args), call.session,
        session_view(call.session, call.namespace.registry.policies))
