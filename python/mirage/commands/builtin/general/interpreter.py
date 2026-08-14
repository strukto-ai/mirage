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

from dataclasses import dataclass, field
from typing import Any, Literal, TypeAlias

from mirage.commands.builtin.utils.paths import resolve_script
from mirage.commands.builtin.utils.stream import _read_stdin_async
from mirage.io.types import ByteSource, CommandOutput, IOResult
from mirage.runtime.base import Runtime
from mirage.runtime.language import LanguageRuntime
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.types import DispatchFn, RunArgs, RunResult
from mirage.types import PathSpec


def run_output(result: RunResult) -> CommandOutput:
    """Convert one interpreter outcome into a command's output shape.

    The single RunResult-to-IOResult mapping: empty stdout becomes
    None (no stream), the exit code and stderr pass through. The
    interpreter commands and the CLI script arm both convert through
    here so the mapping cannot drift.

    Args:
        result (RunResult): the interpreter execution outcome.
    """
    return result.stdout if result.stdout else None, IOResult(
        exit_code=result.exit_code,
        stderr=result.stderr,
    )


# Which of an interpreter's four doors the source came through. The
# mode is what decides argv[0], so the two travel together: CPython
# spells it "-c" for a payload, the module's file for -m, the file as
# typed for a script, "-" for the explicit stdin operand, and "" for
# stdin with no operand at all. Pinned on CPython 3.12.13.
SourceMode: TypeAlias = Literal["payload", "module", "file", "stdin"]

STDIN_OPERAND = "-"


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


@dataclass(frozen=True, slots=True)
class Argv0Rules:
    """What an interpreter calls itself in the doors with no file name.

    File mode is universal (the operand as typed), so only these three
    differ, and they differ per interpreter rather than per language:
    CPython puts "-c" in argv[0] for a payload, while qjs leaves
    scriptArgs alone for `-e` and fills it only when it runs a file. An
    interpreter that names none of them passes None, and its runtime
    sees the unnamed program it saw before.

    Args:
        payload (str | None): argv[0] for a -c/-e payload.
        stdin_operand (str | None): argv[0] for an explicit "-" operand.
        bare_stdin (str | None): argv[0] for a program piped in with no
            operand at all.
        names_file (bool): file mode puts the operand in argv[0]. False
            for qjs, whose scriptArgs start at the first argument even
            when it runs a file, so prepending the path would shift
            every index the program reads.
    """

    payload: str | None = None
    stdin_operand: str | None = None
    bare_stdin: str | None = None
    names_file: bool = False


# CPython's own four answers, pinned on 3.12.13/3.13.7.
CPYTHON_ARGV0 = Argv0Rules(payload="-c",
                           stdin_operand="-",
                           bare_stdin="",
                           names_file=True)

# `-m` is runpy's job on any real CPython: run_module finds the module,
# runs it under __main__, and alter_sys rewrites sys.argv[0] to the
# module's own file, which is what CPython puts there. Engines that are
# not CPython declare runs_modules False and never see this.
#
# The existence probe is not redundant with run_module: CPython answers
# a missing module with one line and exit 1, while bare run_module
# raises, which would reach the user as a runpy traceback. Probing
# first also keeps an ImportError raised INSIDE the module distinct
# from the module itself being absent, which a try around run_module
# could not tell apart.
MODULE_SOURCE = (
    "import importlib.util, runpy, sys\n"
    "_name = {name!r}\n"
    "_label = {label!r}\n"
    "try:\n"
    "    _found = importlib.util.find_spec(_name) is not None\n"
    "except (ImportError, TypeError, ValueError):\n"
    # find_spec raises rather than returning None when an ancestor of a
    # dotted name is missing or is not a package; either way the module
    # cannot be found, and the message below reports it.
    "    _found = False\n"
    "if not _found:\n"
    "    sys.stderr.write(_label + ': No module named ' + _name + chr(10))\n"
    "    raise SystemExit(1)\n"
    "runpy.run_module(_name, run_name='__main__', alter_sys=True)\n")


@dataclass(frozen=True, slots=True)
class Source:
    """An interpreter command's inputs, resolved from the command line.

    Args:
        code (str): the source to run (script content, payload flag,
            or piped stdin).
        args (list[str]): argv exposed to the script, argv[0] excluded.
        stdin (bytes | None): remaining stdin after any consumed as
            source.
        script_path (PathSpec | None): the resolved script operand,
            None for payload/stdin sources.
        mode (SourceMode): which door the source came through.
        argv0 (str | None): the program's own name for argv[0],
            derived from the mode and the interpreter's own rules. ""
            is meaningful (CPython's answer for stdin with no operand);
            None means this interpreter names no program here.
    """

    code: str
    args: list[str] = field(default_factory=list)
    stdin: bytes | None = None
    script_path: PathSpec | None = None
    mode: SourceMode = "payload"
    argv0: str | None = None


async def resolve_source(
    label: str,
    paths: list[PathSpec] | None,
    texts: list[str],
    payload: str | None,
    stdin: ByteSource | None,
    dispatch: DispatchFn | None,
    cwd: PathSpec | str | None,
    exec_allowed: bool,
    module: str | None = None,
    argv0_rules: Argv0Rules = Argv0Rules(),
    skip_line: bool = False,
) -> tuple[CommandOutput | None, Source | None]:
    """Resolve what an interpreter command should run, shared by all.

    The GNU-style resolution every interpreter command follows: a
    payload flag wins (-c/-e), else the first operand is the script
    (read through the workspace dispatch), else piped stdin is the
    source. Words after the script pass through verbatim as argv.

    Args:
        label (str): the command name used in error messages.
        paths (list[PathSpec] | None): positional path operands.
        texts (list[str]): positional text operands.
        payload (str | None): the -c/-e flag value, if given.
        stdin (ByteSource | None): piped stdin.
        dispatch (DispatchFn | None): workspace dispatch for
            reading the script operand.
        cwd (PathSpec | str | None): the session cwd for script
            resolution, as ``CommandOpts.cwd`` carries it.
        exec_allowed (bool): whether the root mount is in EXEC mode.
        module (str | None): the -m module name, if given.
        argv0_rules (Argv0Rules): what this interpreter calls itself in
            the doors that carry no file name.
        skip_line (bool): drop the script file's first line (CPython's
            -x). File mode only, which is CPython's own scope: -c, -m
            and stdin are unaffected.

    Returns:
        tuple[CommandOutput | None, Source | None]: an early
            error result, or the prepared source (exactly one is not
            None).
    """
    if not exec_allowed:
        err = f"{label}: root mount '/' is not in EXEC mode\n".encode()
        return (None, IOResult(exit_code=126, stderr=err)), None

    paths = paths or []
    text_list = list(texts)
    code = payload
    script_path: PathSpec | None = None
    mode: SourceMode = "payload"
    argv0: str | None = argv0_rules.payload
    if module is not None:
        # runpy's alter_sys overwrites argv[0] with the module's own
        # file, which no caller can know here; the module name stands
        # in for the runtimes that never reach runpy.
        code = MODULE_SOURCE.format(name=module, label=label)
        arg_strs = [p.virtual for p in paths] + text_list
        mode = "module"
        argv0 = module
    elif code is not None:
        arg_strs = [p.virtual for p in paths] + text_list
    elif paths:
        script_path = paths[0]
        arg_strs = [p.virtual for p in paths[1:]] + text_list
        mode = "file"
        argv0 = paths[0].raw_path if argv0_rules.names_file else None
    elif text_list and text_list[0] == STDIN_OPERAND:
        # The explicit stdin spelling. It is an operand, not a flag, so
        # it ends option parsing like any other, and the words after it
        # are the program's argv exactly as a script's would be.
        arg_strs = text_list[1:]
        mode = "stdin"
        argv0 = argv0_rules.stdin_operand
    elif text_list:
        script_path = resolve_script(text_list[0], cwd)
        arg_strs = text_list[1:]
        mode = "file"
        # As typed, which is what CPython puts in argv[0]; the resolved
        # spelling is script_path's job.
        argv0 = text_list[0] if argv0_rules.names_file else None
    else:
        arg_strs = []
        mode = "stdin"
        argv0 = argv0_rules.bare_stdin

    if code is None and script_path is not None:
        if dispatch is None:
            err = f"{label}: no dispatch available to read script\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None
        try:
            data, _ = await dispatch("read", script_path)
        except FileNotFoundError:
            err = f"{label}: {script_path.virtual}: No such file\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None
        code = data.decode(errors="replace") if isinstance(data, bytes) else ""
        if skip_line:
            code = skip_first_line(code)

    stdin_data = await _read_stdin_async(stdin)
    if code is None:
        if stdin_data:
            code = stdin_data.decode(errors="replace")
            stdin_data = None
        else:
            err = f"{label}: no input\n".encode()
            return (None, IOResult(exit_code=1, stderr=err)), None

    return None, Source(code=code,
                        args=arg_strs,
                        stdin=stdin_data,
                        script_path=script_path,
                        mode=mode,
                        argv0=argv0)


async def run_code(
    label: str,
    prepared: Source,
    env: dict[str, str] | None,
    flags: dict[str, Any],
    runtime: Runtime | None,
    unavailable: str | None,
) -> CommandOutput:
    """Run a prepared source on the bound runtime, shared by all.

    An unbound command (no workspace runtime entry captures it) is
    refused: an explicit runtimes list is policy, and a builtin that
    spun up its own interpreter would bypass captures and admission
    scripts (TS parity). The refusal names the recorded reason when
    the default world dropped the entry (the registry keys build
    failures by captured command), so no command code ever names a
    runtime class or probes one.

    Args:
        label (str): the command name used in error messages.
        prepared (Source): the resolved source and argv.
        env (dict[str, str] | None): the session environment.
        flags (dict[str, Any]): interpreter-level switches for the
            runtime (each runtime reads its own).
        runtime (Runtime | None): the workspace-bound runtime for this
            command; None when no entry captures it.
        unavailable (str | None): the dispatcher-recorded reason this
            command has no runtime (a default entry's build error),
            None when nothing captures it at all.
    """
    if not isinstance(runtime, LanguageRuntime):
        # GNU wording (bash prints `bash: python3: command not found`;
        # the shell prefix is dropped workspace-wide), unless the
        # default world recorded why the entry failed to build. A bound
        # entry without the interpreter door (not a LanguageRuntime) is
        # refused the same way: there is nothing to run code on.
        hint = unavailable or "command not found"
        return None, IOResult(exit_code=127,
                              stderr=f"{label}: {hint}\n".encode())
    if (prepared.mode == "module" and isinstance(runtime, PythonRuntime)
            and not runtime.runs_modules):
        # Exit 1, CPython's code for a `-m` that could not run, but not
        # its "No module named" wording: nothing was searched for, so
        # naming the runtime is the honest report.
        err = (f"{label}: -m is not supported by the {runtime.name!r} "
               f"runtime\n").encode()
        return None, IOResult(exit_code=1, stderr=err)
    result = await runtime.run(
        RunArgs(code=prepared.code,
                args=prepared.args,
                prog=prepared.argv0,
                env=env or {},
                stdin=prepared.stdin,
                flags=flags))
    return run_output(result)
