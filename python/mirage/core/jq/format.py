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

from dataclasses import replace

from mirage.core.jq.codec import run_codec
from mirage.core.jq.types import JqError, JqHalt, JqOptions, JqRun
from mirage.errors.fs import fs_strerror
from mirage.io.yield_budget import YieldBudget
from mirage.rs.errors import StreamRefusal
from mirage.types import JsonValue


def _config(
    opts: JqOptions, *, separator: bool, check_only: bool
) -> dict[str, JsonValue]:
    return {
        "raw_output": opts.raw_output,
        "join_output": opts.join_output,
        "nul_output": opts.nul_output,
        "compact": opts.compact,
        "ascii_output": opts.ascii_output,
        "sort_keys": opts.sort_keys,
        "tab": opts.tab,
        "indent": opts.indent,
        "seq": opts.seq,
        "separator": separator,
        "check_only": check_only,
    }


async def dump_text(text: str, opts: JqOptions) -> str:
    """Lay out a compact evaluator dump without converting numeric literals.

    Args:
        text (str): compact evaluator output.
        opts (JqOptions): resolved output options.
    """
    plain = replace(opts, raw_output=False, seq=False)
    config = _config(plain, separator=False, check_only=False)
    return b"".join(
        [part async for part in run_codec("jq_format", config, text.encode())]
    ).decode()


async def format_one(text: str, opts: JqOptions) -> bytes:
    """Render one evaluator dump with its separator in bounded Rust steps.

    Args:
        text (str): compact evaluator output.
        opts (JqOptions): resolved output options.
    """
    config = _config(opts, separator=True, check_only=False)
    return b"".join(
        [part async for part in run_codec("jq_format", config, text.encode())]
    )


async def printable(run: JqRun[str], opts: JqOptions) -> JqRun[str]:
    """Apply the shared formatter's raw-NUL refusal before printing a run.

    Args:
        run (JqRun[str]): compact outputs and the evaluator stop.
        opts (JqOptions): resolved output options.
    """
    if not opts.nul_output or opts.ascii_output:
        return run
    config = _config(opts, separator=False, check_only=True)
    budget = YieldBudget()
    for at, text in enumerate(run.outputs):
        await budget.run()
        try:
            async for _ in run_codec("jq_format", config, text.encode()):
                pass
        except StreamRefusal as exc:
            return JqRun(run.outputs[:at], JqError(exc.message, True))
    return run


def error_report(position: str, error: JqError) -> str:
    """jq's report of an error no `try` caught, which it writes to stderr.

    A string message is printed the way C prints a string, so it ends at
    a NUL.

    Args:
        position (str): where jq's reader stands.
        error (JqError): the error.
    """
    if error.string:
        text = error.text.split("\0", 1)[0]
        return f"jq: error (at {position}): {text}\n"
    return f"jq: error (at {position}) (not a string): {error.text}\n"


def load_failure(name: str, exc: BaseException) -> str:
    """Why jq could not load a whole file (jv_load_file): an -f program,
    a --rawfile or a --slurpfile. It opens the file itself, so a
    directory gets words of its own instead of a failed read.

    Args:
        name (str): the file as typed.
        exc (BaseException): why it could not be read.
    """
    if isinstance(exc, IsADirectoryError):
        return f"Could not open {name}: It's a directory"
    return f"Could not open {name}: {fs_strerror(exc)}"


def halt_report(halt: JqHalt) -> str:
    """What jq writes to stderr for a halt: a string as it is, anything
    else dumped on a line of its own, and nothing for `halt` or a null.

    Args:
        halt (JqHalt): the halt.
    """
    if halt.message is None:
        return ""
    return halt.message if halt.string else f"{halt.message}\n"
