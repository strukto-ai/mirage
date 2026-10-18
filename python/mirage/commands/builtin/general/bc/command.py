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

from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

from .constants import MATH_LIBRARY_SCALE
from .errors import (
    BcHalt,
    BcParseError,
    BcRuntimeError,
    parse_error_line,
    runtime_error_line,
)
from .lexer import parse_input
from .parser import eval_statement
from .render import OutputColumn, output_line_length
from .types import BcState, BcStatement


def snapshot_state(state: BcState) -> BcState:
    """Copy the state a discarded line has to be rolled back to.

    GNU compiles a whole line and runs it only if all of it parsed, so a
    parse error anywhere on the line undoes every write the line made:
    `x=5;1 2` leaves `x` unset and `ibase=1;1 2` leaves `ibase` at ten.

    Args:
        state (BcState): the live state.

    Returns:
        BcState: a copy holding the registers and the symbol table. The
            warnings list is not copied, because a line's warnings are
            buffered by the caller rather than kept on the state.
    """
    return BcState(
        scale=state.scale,
        math_mode=state.math_mode,
        ibase=state.ibase,
        obase=state.obase,
        last=state.last,
        variables=dict(state.variables),
    )


def restore_state(state: BcState, saved: BcState) -> None:
    """Undo every write a discarded line made.

    Args:
        state (BcState): the live state, written in place because the
            parser holds a reference to it.
        saved (BcState): what `snapshot_state` recorded before the line.
    """
    state.scale = saved.scale
    state.ibase = saved.ibase
    state.obase = saved.obase
    state.last = saved.last
    state.variables = dict(saved.variables)


def error_line(statement: BcStatement, error: BcParseError) -> int:
    """The input line GNU charges a parse diagnostic to.

    Args:
        statement (BcStatement): the statement being parsed.
        error (BcParseError): the diagnostic.

    Returns:
        int: an incomplete construct is charged to the line its own
            terminator sits on; anything else to the line the offending
            character sits on.
    """
    if error.incomplete:
        return statement.incomplete_line
    if 0 <= error.pos < len(statement.lines):
        return statement.lines[error.pos]
    return statement.lines[0]


async def run_lines(
    lines: AsyncIterator[list[BcStatement] | str],
    state: BcState,
    folder: OutputColumn,
    errors: list[str],
) -> AsyncGenerator[bytes, None]:
    """Run each logical line as it arrives and yield what it prints.

    Args:
        lines (AsyncIterator[list[BcStatement] | str]): ``parse_input``'s
            lines, or its end-of-input diagnostic.
        state (BcState): the interpreter state, updated in place.
        folder (OutputColumn): folds the output at the line length.
        errors (list[str]): receives every diagnostic, in order.
    """
    halted = False
    async for statements in lines:
        if isinstance(statements, str):
            errors.append(statements)
            continue
        # GNU compiles one whole line and runs it at its newline, so a
        # parse error anywhere on the line means none of it ever ran: the
        # values, the runtime errors, the warnings and every write are
        # buffered here and thrown away if any statement refused to
        # parse. The parse diagnostics themselves are not buffered --
        # GNU reports one per bad statement even on a line it discards.
        saved = snapshot_state(state)
        saved_col = folder.col
        line_results: list[str] = []
        line_errors: list[str] = []
        parse_errors: list[str] = []
        # A runtime error is fatal to the rest of its own line and
        # non-fatal to every later one, so `1/0;2+2` prints nothing and
        # `1/0\n2+2\n` prints 4. It does not roll the line back the way
        # a parse error does: `x=5;1/0;y=7` leaves `x` at 5 and `y` unset.
        aborted = False
        for statement in statements:
            # A statement after a `halt`, after a runtime error, or on a
            # line a `quit` cut short is still parsed -- GNU compiles the
            # whole line before running any of it, which is where
            # `1+1;halt;1 2`'s syntax error comes from -- but never runs.
            runs = statement.execute and not halted and not aborted
            # A statement that does not run is parsed against a throwaway
            # copy, so it cannot write: GNU never executes it, and
            # `x=5;1/0;y=7` has to leave `y` unset while leaving `x` at 5.
            target = state if runs else snapshot_state(state)
            # Owned here rather than inside the parser, so that a runtime
            # error partway down a `print` list keeps the text already
            # written: `print "x", 1/0` writes the `x`.
            writes: list[str] = []
            try:
                eval_statement(statement.text, target, writes)
            except BcParseError as exc:
                parse_errors.append(
                    parse_error_line(error_line(statement, exc), exc.text)
                )
            except BcRuntimeError as exc:
                # Reported unless the line turns out to be discarded,
                # which is why it is buffered: `1/0;2+2` reports the
                # division where `1/0;1 2` reports only the syntax error.
                if runs:
                    # Warnings the same statement already raised come
                    # first: `0^-1.5` warns about the exponent's scale
                    # and then refuses, in that order.
                    line_errors.extend(state.warnings)
                    state.warnings.clear()
                    line_errors.append(runtime_error_line(str(exc)))
                    aborted = True
            except BcHalt:
                # `halt` ends the run where it is reached, so everything
                # earlier on its line has already printed.
                halted = runs
            if runs:
                line_errors.extend(state.warnings)
            state.warnings.clear()
            if not runs:
                continue
            # The one place output is folded. Rendering happened as each
            # element was reached, in `Parser._emit`, because GNU's `obase`
            # and `last` can both change partway down a `print` list.
            for piece in writes:
                line_results.append(folder.write(piece))
        if parse_errors:
            # None of the line ran, so a `halt` on it did not run either,
            # and the column never moved: GNU compiles the line before it
            # writes anything, so a later statement's syntax error undoes
            # an earlier one's `print`.
            errors.extend(parse_errors)
            restore_state(state, saved)
            folder.col = saved_col
            halted = False
            continue
        errors.extend(line_errors)
        if line_results:
            yield "".join(line_results).encode()
        if halted:
            break


@command("bc", vfs=None, spec=SPECS["bc"])
async def bc(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["bc"])
    use_math = fl.as_bool("args_l")
    state = BcState(
        scale=MATH_LIBRARY_SCALE if use_math else 0, math_mode=use_math
    )
    folder = OutputColumn(output_line_length(ctx.env))
    errors: list[str] = []
    lines = parse_input(ctx.stdin if ctx.stdin is not None else b"")
    io = IOResult()

    async def output() -> AsyncIterator[bytes]:
        try:
            async with aclosing(
                run_lines(lines, state, folder, errors)
            ) as chunks:
                async for chunk in chunks:
                    yield chunk
        finally:
            await lines.aclose()
            io.stderr = format_optional_records(errors)

    return output(), io
