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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from mirage.commands.config import Context
from mirage.commands.spec.types import FlagValue
from mirage.io.types import materialize
from mirage.runtime.types import Program, RunResult
from mirage.types import PathSpec

STDIN_OPERAND = "-"


@dataclass(frozen=True, slots=True)
class Argv0Rules:
    """What an interpreter calls itself in the entry points with no file name.

    They differ per interpreter, not per language: CPython puts "-c" in
    argv[0] for a payload, while qjs leaves scriptArgs alone for `-e`.

    Args:
        payload (str | None): argv[0] for a -c/-e payload.
        stdin_operand (str | None): argv[0] for an explicit "-" operand.
        bare_stdin (str | None): argv[0] for a program piped in with no
            operand at all.
        names_file (bool): file mode puts the operand in argv[0]; False
            for qjs, whose scriptArgs start at the first argument.
    """

    payload: str | None = None
    stdin_operand: str | None = None
    bare_stdin: str | None = None
    names_file: bool = False


def skip_first_line(code: str) -> str:
    """Drop a script's first line the way CPython's ``-x`` does.

    The first line is emptied rather than removed, because CPython
    keeps the line numbering of the whole file: a raise on physical
    line 2 still reports line 2 under ``-x`` (pinned on 3.12.11). A
    file with no newline at all is one line, so ``-x`` leaves nothing.

    Args:
        code (str): the script's text as read.
    """
    _, sep, rest = code.partition("\n")
    return sep + rest if sep else ""


def script_operand(
    paths: Sequence[PathSpec],
    texts: Sequence[str],
    flags: Mapping[str, FlagValue],
    cwd: PathSpec | str | None,
) -> PathSpec | None:
    """The script an interpreter's operands name, None when the program
    comes from ``-c``, ``-m`` or stdin. The exec check and the runtime
    both ask it, so they agree.

    Args:
        paths (Sequence[PathSpec]): the path operands.
        texts (Sequence[str]): the text operands.
        flags (Mapping[str, FlagValue]): the interpreter switches.
        cwd (PathSpec | str | None): the working directory a text
            operand resolves against.
    """
    if isinstance(flags.get("m"), str) or isinstance(flags.get("c"), str):
        return None
    if paths:
        return paths[0]
    if texts and texts[0] != STDIN_OPERAND:
        return PathSpec.from_str_path(texts[0], cwd=cwd or "/")
    return None


def _failed(message: str) -> RunResult:
    """An interpreter that ran nothing: its message and exit 1.

    Args:
        message (str): what it says on stderr, newline included.
    """
    return RunResult(stdout=b"", stderr=message.encode(), exit_code=1)


async def resolve_program(
    paths: Sequence[PathSpec],
    texts: Sequence[str],
    ctx: Context,
    label: str,
    rules: Argv0Rules,
    module_code: Callable[[str, str], str | None],
    runtime_name: str,
) -> Program | RunResult:
    """Resolve what a language runtime runs from its operands, as a real
    interpreter does.

    ``-c`` wins, else ``-m`` names a module, else the first operand is
    the script (read through ``ctx.vfs``), else piped stdin is the
    program. A script CLI names itself ``ctx.spec.name``.

    Args:
        paths (Sequence[PathSpec]): the path operands.
        texts (Sequence[str]): the text operands.
        ctx (Context): the run's context; ``flags`` holds the switches
            (``c``, ``m``, ``x``, ``script_cli``).
        label (str): the command name the messages use.
        rules (Argv0Rules): what this interpreter calls itself in the
            entry points that carry no file name.
        module_code (Callable[[str, str], str | None]): the program a
            ``-m`` runs, given the module and the label; None when this
            runtime cannot run a module.
        runtime_name (str): the runtime's name, for the ``-m`` refusal.

    Returns:
        Program | RunResult: the program, or why nothing ran.
    """
    flags = ctx.flags
    payload = flags.get("c")
    module = flags.get("m")
    words = list(texts)
    code = payload if isinstance(payload, str) else None
    script: PathSpec | None = None
    argv0 = rules.payload
    if isinstance(module, str):
        # runpy's alter_sys overwrites argv[0] with the module's own
        # file, which no caller can know here; the module name stands
        # in for the runtimes that never reach runpy.
        code = module_code(module, label)
        if code is None:
            return _failed(
                f"{label}: -m is not supported by the {runtime_name!r} "
                "runtime\n"
            )
        args = [p.virtual for p in paths] + words
        argv0 = module
    elif code is not None:
        args = [p.virtual for p in paths] + words
    elif paths:
        script = paths[0]
        args = [p.virtual for p in paths[1:]] + words
        argv0 = paths[0].raw_path if rules.names_file else None
    elif words and words[0] == STDIN_OPERAND:
        # The explicit stdin spelling. It is an operand, not a flag, so
        # it ends option parsing like any other, and the words after it
        # are the program's argv exactly as a script's would be.
        args = words[1:]
        argv0 = rules.stdin_operand
    elif words:
        script = script_operand(paths, words, flags, ctx.cwd)
        args = words[1:]
        # As typed, which is what CPython puts in argv[0]; the resolved
        # spelling is script's job.
        argv0 = words[0] if rules.names_file else None
    else:
        args = []
        argv0 = rules.bare_stdin
    if code is None and script is not None:
        if ctx.vfs is None:
            return _failed(f"{label}: no dispatch available to read script\n")
        try:
            data, _ = await ctx.vfs.dispatch("read", script)
        except FileNotFoundError:
            return _failed(f"{label}: {script.virtual}: No such file\n")
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""
        if flags.get("x"):
            code = skip_first_line(code)
    stdin = ctx.stdin
    if code is None:
        source = None if stdin is None else await materialize(stdin)
        if not source:
            return _failed(f"{label}: no input\n")
        code = source.decode(errors="replace")
        stdin = None
    script_cli = bool(flags.get("script_cli"))
    if script_cli and ctx.spec is not None:
        argv0 = ctx.spec.name
    return Program(
        code=code,
        args=args,
        prog=argv0,
        stdin=stdin,
        script_path=script,
        script_cli=script_cli,
    )
