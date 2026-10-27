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

import functools
import json
import logging
import re
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import cast

import jq as _libjq

from mirage.core.jq.errors import JqCompileError
from mirage.core.jq.parse import string_text
from mirage.core.jq.types import JqError, JqHalt, JqOptions, JqRun, StreamReads
from mirage.core.render.json import compact_json_text
from mirage.types import JsonValue

logger = logging.getLogger(__name__)

INPUT_REF = re.compile(r"(?<![\w$.:])input(?![\w:])")
INPUTS_REF = re.compile(r"(?<![\w$.:])inputs(?![\w:])")
INPUT_DEF = re.compile(r"(?<![\w$.:])def\s+input\s*[:(]")
INPUTS_DEF = re.compile(r"(?<![\w$.:])def\s+inputs\s*[:(]")
ARGS_REF = re.compile(r"\$ARGS(?![\w:])")
HALT_ERROR_REF = re.compile(r"(?<![\w$.:])halt_error(?![\w:])")
ERROR_CALL = re.compile(r"(?<![\w$.])(?<!::)error(?!\w)(?!::)")
TOP_LEVEL_LINE = re.compile(r"(at <top-level>, line )(\d+)")
IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
INTERP = "\\("
OPENERS = "([{"
CLOSERS = ")]}"

# The keys the prelude hands a run's stop back under: the error no `try`
# caught, the halt `halt` or `halt_error` asked for, and the end of a run
# that did not halt. Each carries a token drawn once per process, so no
# output of a program can pass for one.
_TOKEN = uuid.uuid4().hex
ERROR_KEY = f"__mirage_jq_error_{_TOKEN}"
HALT_KEY = f"__mirage_jq_halt_{_TOKEN}"
DONE_KEY = f"__mirage_jq_done_{_TOKEN}"

# The variables the prelude binds: the document the program runs on, the
# --arg / --argjson / --rawfile / --slurpfile bindings by name, the unread
# documents `input` and `inputs` read, the parse error they meet past the
# last of them, the value it rebinds `$ARGS` to, and the environment it
# rebinds `$ENV` and `env` to. They carry the same token, so no `--arg` of
# the program's own can take one's place.
VALUE_VAR = f"__mirage_jq_value_{_TOKEN}"
NAMED_VAR = f"__mirage_jq_named_{_TOKEN}"
INPUTS_VAR = f"__mirage_jq_inputs_{_TOKEN}"
INPUTS_ERROR_VAR = f"__mirage_jq_inputs_error_{_TOKEN}"
ARGS_VAR = f"__mirage_jq_args_{_TOKEN}"
ENV_VAR = f"__mirage_jq_env_{_TOKEN}"

# The error no `try` inside the program caught: whether it was a string,
# and its text as jq prints it.
_ERROR_MARK = (
    '{"' + ERROR_KEY + '": [(type == "string"), '
    '(if type == "string" then . else tojson end)]}'
)
_CATCH = f" catch {_ERROR_MARK}"
_DONE = ', {"' + DONE_KEY + '": true}'
# A run that hands its outputs back as text pipes every one, stops and
# sentinel included, into jq's own compact dump of it, the text jq's main
# loop prints from. Bind the builtin before the user program can shadow
# it, under a private name shared by the wrapped and as-typed paths.
_DUMPER = f"__mirage_jq_dump_{_TOKEN}"
_DUMP_DEF = f"def {_DUMPER}: tojson; "
_DUMP = f"| {_DUMPER}"

# A run keeps jq's own `halt` and `halt_error`, which no `try` catches and
# which end the program wherever they are called; one that halted is the
# run that never reaches the sentinel after the program. libjq's binding
# says nothing more of a halt, so its message and code come from running
# the program again with the two redefined, first to raise them as an
# error the top-level `catch` hands back (which leaves any collector,
# `[halt_error]` or `map`), and when a `try` of the program's own caught
# that, to print them just before the real halt. Either answer counts only
# when the run printed as many outputs up to it as the first run did: the
# runs are one run up to the first halt, so a later halt shows as more
# outputs before it, where the values themselves can differ (`now`). Two
# things still get past that: a `try` that swallows one halt unseen before
# the program reaches another, and a halt whose message or choice rests on
# `now`, which the rerun reads again.
_HALT_MARK = (
    '{"' + HALT_KEY + '": [$code, (if . == null then null '
    'elif type == "string" then . else tojson end), '
    '(type == "string")]}'
)
_BUILTINS = (
    "def __mirage_jq_halt: halt; "
    "def __mirage_jq_halt_error($code): halt_error($code); "
)
_RAISE = (
    _BUILTINS + 'def halt: error({"' + HALT_KEY + '": [null, null, false]}); '
    'def halt_error($code): if ($code | type) == "number" then '
    f"error({_HALT_MARK}) else __mirage_jq_halt_error($code) end; "
    "def halt_error: halt_error(5); "
)
_RAISED = (
    ' catch (if type == "object" and has("'
    + HALT_KEY
    + f'") then . else {_ERROR_MARK} end)'
)
_PRINT = (
    _BUILTINS
    + 'def halt: {"'
    + HALT_KEY
    + '": [null, null, false]}, __mirage_jq_halt; '
    'def halt_error($code): if ($code | type) == "number" then '
    f"{_HALT_MARK}, __mirage_jq_halt_error($code) "
    "else __mirage_jq_halt_error($code) end; "
    "def halt_error: halt_error(5); "
)

# Whether the program's own `error` raised the error a run stopped at comes
# from running it again with every `error` it spells renamed to _RAISER, so
# a builtin's error, and the `error` jq compiles `label` and `break` to,
# stay as they were. The first rerun raises the value wrapped under
# WRAP_KEY, which leaves any collector the way the error itself would, and
# the top-level `catch` hands it back under RAISED_KEY; the second prints
# it under RAISED_KEY just before raising it unchanged, which is what a
# `catch` of the program's own that reads the value still sees. Either
# answer counts only when the rerun stops at the same error after as many
# outputs as the run printed, as a halt's does: the values themselves can
# differ between the runs (`now`).
WRAP_KEY = f"__mirage_jq_wrap_{_TOKEN}"
RAISED_KEY = f"__mirage_jq_raised_{_TOKEN}"
_RAISER = "__mirage_jq_raise"
_RAISED_MARK = (
    '{"' + RAISED_KEY + '": [(type == "string"), '
    '(if type == "string" then . else tojson end)]}'
)
_WRAP = (
    f'def {_RAISER}: if type == "object" and has("{WRAP_KEY}") '
    f'then error else error({{"{WRAP_KEY}": .}}) end; '
    f"def {_RAISER}(msg): msg | {_RAISER}; "
)
_UNWRAP = (
    f' catch (if type == "object" and has("{WRAP_KEY}") '
    f'then .["{WRAP_KEY}"] | {_RAISED_MARK} else {_ERROR_MARK} end)'
)
_MARK = (
    f"def {_RAISER}: {_RAISED_MARK}, error; "
    f"def {_RAISER}(msg): msg | {_RAISER}; "
)


def code_only(expr: str) -> str:
    """Blank out every part of a jq program that cannot be a call.

    Three things are replaced by spaces: string bodies, `#` comments,
    and the field names an object shorthand abbreviates (`{a, inputs}`
    is `{a: .a, inputs: .inputs}`). Interpolations stay code, because
    `"\\(inputs)"` really does call the builtin, so everything between
    `\\(` and its closing paren survives, nested strings included.

    Args:
        expr (str): jq program text.
    """
    out: list[str] = []
    # Open brackets, innermost last, with an interpolation recorded as
    # one too; empty means the scan is at the top level of the program.
    stack: list[str] = []
    in_string = False
    prev = ""
    i = 0
    while i < len(expr):
        ch = expr[i]
        if in_string:
            if ch == "\\" and i + 1 < len(expr):
                if expr[i + 1] == "(":
                    in_string = False
                    stack.append(INTERP)
                out.append("  ")
                i += 2
                continue
            in_string = ch != '"'
            out.append(" ")
            i += 1
            continue
        if ch == '"':
            in_string = True
            out.append(" ")
            i += 1
            continue
        if ch == "#":
            while i < len(expr) and expr[i] != "\n":
                out.append(" ")
                i += 1
            continue
        word = IDENT.match(expr, i)
        if word is not None:
            text = word.group()
            key = bool(stack) and stack[-1] == "{" and prev in ("{", ",")
            out.append(" " * len(text) if key else text)
            prev = text[-1]
            i = word.end()
            continue
        if ch in OPENERS:
            stack.append(ch)
        elif ch == ")" and stack and stack[-1] == INTERP:
            stack.pop()
            in_string = True
            out.append(" ")
            prev = ""
            i += 1
            continue
        elif ch in CLOSERS and stack and stack[-1] != INTERP:
            stack.pop()
        out.append(ch)
        if not ch.isspace():
            prev = ch
        i += 1
    return "".join(out)


def references_args(expr: str) -> bool:
    """Report whether a jq program reads the `$ARGS` variable.

    Args:
        expr (str): jq program text.
    """
    return ARGS_REF.search(code_only(expr)) is not None


def args_text(opts: JqOptions) -> str:
    """The JSON text of the value `$ARGS` resolves to for a run.

    Args:
        opts (JqOptions): resolved options carrying both binding kinds.
    """
    positional = ",".join(opts.positional_args)
    named = ",".join(
        f"{string_text(name)}:{text}" for name, text in opts.named_args.items()
    )
    return f'{{"positional":[{positional}],"named":{{{named}}}}}'


def stream_reads(expr: str) -> StreamReads:
    """Report which of the builtins that read the input stream a program
    calls.

    Binding the unread documents is what makes `input` and `inputs`
    work, and it also changes how many documents a run consumes, so only
    the builtins may answer here: the words also spell a field
    (`.inputs`, `{inputs}`), a variable (`$inputs`), an object key
    (`{inputs: 1}`), a module member (`m::inputs`), a function the
    program defines for itself (`def input: ...`), and anything at all
    inside a string or a comment, none of which read the stream.

    Args:
        expr (str): jq program text.
    """
    code = code_only(expr)
    return StreamReads(
        input=INPUT_REF.search(code) is not None
        and INPUT_DEF.search(code) is None,
        inputs=INPUTS_REF.search(code) is not None
        and INPUTS_DEF.search(code) is None,
    )


def _stream_defs(expr: str, failed: bool) -> str:
    """The definitions `input` and `inputs` read the unread documents
    through.

    `input` takes the first of them and, once none is left, fails the
    way jq 1.7 and 1.8 both do, with the error `break`. `inputs` yields
    the ones after it, or all of them when the program never calls
    `input`: the stream as the two builtins leave it for each other when
    `input` runs once, ahead of `inputs`. When the stream ended in a
    parse error, the reader past the last document meets that instead,
    and both raise it as an error the program can catch.

    Args:
        expr (str): jq program text.
        failed (bool): whether the stream ended in a parse error, bound
            as its own named argument.
    """
    docs = f"${INPUTS_VAR}"
    rest = f"{docs}[1:]" if stream_reads(expr).input else docs
    end = f"error(${INPUTS_ERROR_VAR})" if failed else 'error("break")'
    tail = f", error(${INPUTS_ERROR_VAR})" if failed else ""
    return (
        f"def input: if ({docs} | length) > 0 then {docs}[0] "
        f"else {end} end; def inputs: {rest}[]{tail};"
    )


def _unshifted(message: str, shift: int) -> str:
    """A compile error as the program's own lines number it.

    Args:
        message (str): libjq's error text.
        shift (int): lines the prelude put ahead of the program.
    """
    if shift == 0:
        return message
    return TOP_LEVEL_LINE.sub(
        lambda match: f"{match.group(1)}{int(match.group(2)) - shift}", message
    )


def _balanced(code: str) -> bool:
    """Whether every bracket in a program's code closes the one opened
    last, which is what keeps the program whole inside the prelude's own
    parentheses: code that closes one early could otherwise pair with
    them into a program jq itself would refuse.

    Args:
        code (str): the program as code_only leaves it.
    """
    stack: list[str] = []
    for ch in code:
        if ch in OPENERS:
            stack.append(ch)
        elif ch in CLOSERS and (
            not stack or OPENERS[CLOSERS.index(ch)] != stack.pop()
        ):
            return False
    return not stack


def _stop_of(value: JsonValue) -> JqError | JqHalt | None:
    """The stop the prelude hands back as a run's output, when this
    output is one.

    Args:
        value (JsonValue): one output of the run.
    """
    if not isinstance(value, dict) or len(value) != 1:
        return None
    error = value.get(ERROR_KEY)
    if isinstance(error, list) and len(error) == 2:
        return JqError(str(error[1]), error[0] is True)
    halt = value.get(HALT_KEY)
    if isinstance(halt, list) and len(halt) == 3:
        code, message, string = halt
        text = message if isinstance(message, str) else None
        if isinstance(code, bool) or not isinstance(code, (int, float)):
            return JqHalt(text, string is True, None)
        return JqHalt(text, string is True, code)
    return None


def _collected(
    results: Iterable[JsonValue], dumped: bool = False
) -> tuple[JqRun[JsonValue], bool]:
    """A run's outputs, up to the stop the prelude hands back, and whether
    the run ended by itself rather than stopping at a halt: it reached the
    sentinel, handed back a stop, or failed.

    A run whose outputs libjq dumped (see _DUMP) hands each back as jq's
    compact text, a string; only one that holds the token can be a stop
    or the sentinel, so only such a one is read back.

    Only a program the prelude could not wrap raises its error here, and
    libjq's binding says no more of that error than its text.

    Args:
        results (Iterable[JsonValue]): the program's outputs, as libjq
            yields them.
        dumped (bool): whether each output is jq's dump of one.
    """
    outputs: list[JsonValue] = []
    try:
        for value in results:
            mark = value
            if dumped and isinstance(value, str) and _TOKEN in value:
                mark = json.loads(value)
            if isinstance(mark, dict) and DONE_KEY in mark:
                return JqRun(outputs), True
            stop = None if dumped and mark is value else _stop_of(mark)
            if stop is not None:
                return JqRun(outputs, stop), True
            outputs.append(value)
    except ValueError as exc:
        return JqRun(outputs, JqError(str(exc), True)), True
    return JqRun(outputs), False


@dataclass(frozen=True, slots=True)
class _Bound:
    """One run as libjq is handed it.

    Every value a run binds travels on its input, inside one wrapper
    document the prelude unpacks, as the JSON text jq's own parser reads,
    so a number keeps its literal and an object its key order. A run that
    binds nothing goes on the plain document.

    Args:
        steps (tuple[str, ...]): the prelude steps that unpack the input.
        stdin (str): the input the steps unpack.
        plain (str): the plain document, for a program that goes bare.
    """

    steps: tuple[str, ...]
    stdin: str
    plain: str


def _bound(
    doc: str,
    expr: str,
    named: Mapping[str, str] | None,
    inputs: Sequence[str] | None,
    args: str | None,
    inputs_error: str | None = None,
    env: str | None = None,
) -> _Bound:
    """The bindings one run carries.

    Args:
        doc (str): the document the program runs on.
        expr (str): jq program text.
        named (Mapping[str, str] | None): $name bindings, as text.
        inputs (Sequence[str] | None): the unread documents.
        args (str | None): the value of `$ARGS`.
        inputs_error (str | None): the parse error the stream ends in.
        env (str | None): the environment `$ENV` and `env` read in place
            of the process's, an object as text.
    """
    named = named or {}
    # A name that is not an identifier can never be spelled as a variable,
    # so nothing needs it bound; $ARGS.named still carries it.
    names = [name for name in named if IDENT.fullmatch(name)]
    if not names and inputs is None and args is None and env is None:
        return _Bound((), doc, doc)
    steps = [
        f". as [${VALUE_VAR}, ${NAMED_VAR}, ${INPUTS_VAR}, ${ARGS_VAR}, "
        f"${INPUTS_ERROR_VAR}, ${ENV_VAR}] |"
    ]
    steps.extend(
        f"${NAMED_VAR}[{string_text(name)}] as ${name} |" for name in names
    )
    if inputs is not None:
        steps.append(_stream_defs(expr, inputs_error is not None))
    if args is not None:
        steps.append(f"${ARGS_VAR} as $ARGS |")
    # Bound after the names, so an `--arg ENV` leaves `$ENV` the
    # environment, as jq binds it over one (compile.c).
    if env is not None:
        steps.append(f"${ENV_VAR} as $ENV | def env: ${ENV_VAR};")
    steps.append(f"${VALUE_VAR} |")
    carried = ",".join(
        f"{string_text(name)}:{text}" for name, text in named.items()
    )
    error = "null" if inputs_error is None else string_text(inputs_error)
    stdin = (
        f"[{doc},{{{carried}}},[{','.join(inputs or ())}],"
        f"{args or 'null'},{error},{env or 'null'}]"
    )
    return _Bound(tuple(steps), stdin, doc)


@functools.lru_cache(maxsize=256)
def _compile(program: str) -> _libjq._Program:
    """A program compiled once for every document it runs on: its text
    carries no value, only the names of the bindings.

    Args:
        program (str): the whole program, prelude included.

    Raises:
        ValueError: libjq's refusal of the program.
    """
    return _libjq.compile(program)


def _typed(
    expr: str, bound: _Bound, dump: bool
) -> tuple[_libjq._Program, str, bool]:
    """The program compiled as typed, behind the definitions that print a
    halt just before it: the way a program runs when its code cannot sit
    whole inside the prelude's parentheses. Returns it with the input it
    runs on, and whether it dumps its outputs.

    The prelude costs one line here, so the line a compile error reports
    is moved back by it. A program with no code for jq to run at all goes
    bare, on the plain document, which keeps libjq's own refusal of an
    empty program. A dumped run binds jq's dumper before the user program
    can shadow `tojson`, then pipes its outputs through that private
    binding past a blank line. The blank line ends even a comment whose
    trailing backslash carries it over the next line.

    Args:
        expr (str): jq program text.
        bound (_Bound): the run's bindings.
        dump (bool): whether the run hands its outputs back as text.

    Raises:
        JqCompileError: libjq's refusal of the program, its compile
            errors numbered by the program's own lines.
    """
    shift = 1 if code_only(expr).strip() else 0
    prelude = (_DUMP_DEF if dump else "") + _PRINT + " ".join(bound.steps)
    program = f"{prelude}\n{expr}" if shift else expr
    stdin = bound.stdin if shift else bound.plain
    try:
        compiled = _compile(program)
    except ValueError as exc:
        raise JqCompileError(_unshifted(str(exc), shift)) from exc
    if not dump:
        return compiled, stdin, False
    try:
        return _compile(f"{program}\n\n{_DUMP}"), stdin, True
    except ValueError as exc:
        logger.debug("jq: program refused with its outputs dumped: %s", exc)
        return compiled, stdin, False


def _wrapped(
    expr: str, bound: _Bound, stops: str, tail: str
) -> _libjq._Program | None:
    """The program compiled inside the prelude (see jq_run), or None when
    its code cannot sit whole inside the prelude's parentheses.

    Args:
        expr (str): jq program text.
        bound (_Bound): the run's bindings.
        stops (str): the definitions `halt` and `halt_error` run as.
        tail (str): what follows the program: its `catch`, and the
            sentinel of a run that keeps the real halts.
    """
    code = code_only(expr)
    if not code.strip() or not _balanced(code):
        return None
    prelude = stops + "".join(f"{step} " for step in bound.steps)
    try:
        return _compile(f"{prelude}(try ({expr}\n){tail}")
    except ValueError as exc:
        # A refusal names the prelude's text; the program as typed is
        # what says why.
        logger.debug("jq: program refused inside the prelude: %s", exc)
        return None


def _halt_of(expr: str, bound: _Bound, printed: int) -> JqHalt:
    """The message and code of the halt a run stopped at, from running the
    program again with the halts redefined (see _RAISE and _PRINT).

    Args:
        expr (str): jq program text.
        bound (_Bound): the run's bindings.
        printed (int): how many outputs the run printed before it halted.
    """
    for stops, tail in ((_RAISE, f"{_RAISED})"), (_PRINT, f"{_CATCH})")):
        compiled = _wrapped(expr, bound, stops, tail)
        if compiled is None:
            continue
        again, _ = _collected(compiled.input_text(bound.stdin))
        if isinstance(again.stop, JqHalt) and len(again.outputs) == printed:
            return again.stop
    # A halt caught by the program's own `try` inside a collector keeps
    # its message from both, so it reads as halt_error's default.
    if HALT_ERROR_REF.search(code_only(expr)) is None:
        return JqHalt(None, False, None)
    return JqHalt(None, False, 5)


def _renamed(expr: str) -> str:
    """The program with every `error` it calls, and any it defines, renamed
    to _RAISER.

    Only code is renamed, as code_only leaves it: a field (`.error`), a
    variable (`$error`), an object key or its shorthand (`{error}`), a
    module member (`m::error`), a string and a comment all keep theirs.

    Args:
        expr (str): jq program text.
    """
    parts: list[str] = []
    last = 0
    for match in ERROR_CALL.finditer(code_only(expr)):
        parts.append(expr[last : match.start()])
        parts.append(_RAISER)
        last = match.end()
    parts.append(expr[last:])
    return "".join(parts)


def _raised_mark(value: JsonValue) -> JqError | None:
    """The error a rerun hands back under RAISED_KEY, when this output
    is one.

    Args:
        value (JsonValue): one output of the rerun.
    """
    if not isinstance(value, dict) or len(value) != 1:
        return None
    mark = value.get(RAISED_KEY)
    if isinstance(mark, list) and len(mark) == 2:
        return JqError(str(mark[1]), mark[0] is True)
    return None


def _wrapped_verdict(
    results: Iterable[JsonValue], run: JqRun[JsonValue]
) -> bool | None:
    """What the rerun that wraps the program's own errors says of the one
    a run stopped at: raised by the program when it hands that error back
    under RAISED_KEY, by a builtin when it stops at it as it was, and
    nothing when it stops anywhere else, which a `catch` of the program's
    own that reads a wrapped value can make it do.

    Args:
        results (Iterable[JsonValue]): the rerun's outputs, as libjq
            yields them.
        run (JqRun[JsonValue]): the run that stopped.
    """
    printed = 0
    try:
        for value in results:
            raised = _raised_mark(value)
            stop = _stop_of(value) if raised is None else raised
            if stop is not None:
                if printed != len(run.outputs) or stop != run.stop:
                    return None
                return raised is not None
            if isinstance(value, dict) and DONE_KEY in value:
                return None
            printed += 1
    except ValueError as exc:
        logger.debug("jq: the wrapping rerun failed: %s", exc)
    return None


def _marked_verdict(
    results: Iterable[JsonValue], run: JqRun[JsonValue]
) -> bool | None:
    """Whether the rerun that prints each of the program's own errors just
    before raising it shows the program raised the one a run stopped at:
    it printed as many outputs as the run did, and that error's mark last.

    Args:
        results (Iterable[JsonValue]): the rerun's outputs, as libjq
            yields them.
        run (JqRun[JsonValue]): the run that stopped.
    """
    printed = 0
    last: JqError | None = None
    try:
        for value in results:
            mark = _raised_mark(value)
            if mark is not None:
                last = mark
                continue
            stop = _stop_of(value)
            if stop is not None:
                if printed == len(run.outputs) and stop == run.stop == last:
                    return True
                return None
            if isinstance(value, dict) and DONE_KEY in value:
                return None
            printed += 1
            last = None
    except ValueError as exc:
        logger.debug("jq: the marking rerun failed: %s", exc)
    return None


def _value_text(value: JsonValue) -> str:
    """A value as the JSON text libjq's binding itself hands jq's parser
    for one, NaN and the infinities spelled the way jq reads them.

    Args:
        value (JsonValue): the value.
    """
    return json.dumps(value)


def _value_bound(
    obj: JsonValue,
    expr: str,
    named_args: Mapping[str, JsonValue] | None,
    inputs: Sequence[JsonValue] | None,
    args_value: Mapping[str, JsonValue] | None,
    inputs_error: str | None = None,
) -> _Bound:
    """The bindings of a run on values, each carried as its JSON text.

    Args:
        obj (JsonValue): the value the program runs on.
        expr (str): jq program text.
        named_args (Mapping[str, JsonValue] | None): $name bindings.
        inputs (Sequence[JsonValue] | None): the unread documents.
        args_value (Mapping[str, JsonValue] | None): the value of `$ARGS`.
        inputs_error (str | None): the parse error the stream ends in.
    """
    named = (
        {name: _value_text(value) for name, value in named_args.items()}
        if named_args
        else None
    )
    docs = None if inputs is None else [_value_text(doc) for doc in inputs]
    args = None if args_value is None else _value_text(dict(args_value))
    return _bound(_value_text(obj), expr, named, docs, args, inputs_error)


def _run(expr: str, bound: _Bound, dump: bool) -> JqRun[JsonValue]:
    """One run of the program on its bindings (see jq_run).

    Args:
        expr (str): jq program text.
        bound (_Bound): the run's bindings.
        dump (bool): whether to hand the outputs back as jq's dump text.

    Raises:
        JqCompileError: libjq's refusal of the program, its compile
            errors numbered by the program's own lines.
    """
    tail = f"{_CATCH}){_DONE} {_DUMP}" if dump else f"{_CATCH}){_DONE}"
    compiled = _wrapped(expr, bound, _DUMP_DEF if dump else "", tail)
    if compiled is None:
        program, stdin, dumped = _typed(expr, bound, dump)
        run = _collected(program.input_text(stdin), dumped)[0]
        if dumped or not dump:
            return run
        # The last resort of a program that refused the dump: its values,
        # written back as JSON.
        return JqRun(
            [compact_json_text(value) for value in run.outputs],
            run.stop,
        )
    run, ended = _collected(compiled.input_text(bound.stdin), dump)
    if ended:
        return run
    return JqRun(run.outputs, _halt_of(expr, bound, len(run.outputs)))


def jq_run(
    obj: JsonValue,
    expr: str,
    named_args: Mapping[str, JsonValue] | None = None,
    inputs: Sequence[JsonValue] | None = None,
    args_value: Mapping[str, JsonValue] | None = None,
    inputs_error: str | None = None,
) -> JqRun[JsonValue]:
    """Run a jq program on one value using libjq, the way jq's main loop
    runs it on one document, and hand back the values it printed.

    A jq program is a stream transformer: it emits zero, one or many
    values, and jq prints each on its own line. That arity is preserved
    here rather than collapsed, so two outputs are never confused with
    one output that happens to be an array. `.a, .b` yields two values;
    `[.a, .b]` yields one.

    An error that no `try` catches ends the run, and jq still prints
    what came before it; `halt` and `halt_error` end the whole
    invocation. libjq's binding reports neither whole (an error that is
    not a string arrives as Python's rendering of it, and a halt as the
    plain end of the outputs), so the program runs inside a prelude that
    catches the error and hands it back as the run's last output, with a
    sentinel after the program that only a run that did not halt reaches
    (see _halt_of for what a halt said). The whole prelude sits on the
    program's first line, so the program's lines keep their numbers.

    Args:
        obj (JsonValue): the value the program runs on.
        expr (str): jq program text.
        named_args (Mapping[str, JsonValue] | None): $name bindings from
            --arg / --argjson.
        inputs (Sequence[JsonValue] | None): the documents still unread
            at this point in the stream, which `input` and `inputs` read
            (see _stream_defs). libjq's Python binding owns no input
            stream, so both builtins are bound as definitions over those
            documents instead; a user program that defines its own
            shadows the binding, as it would shadow the builtin.
        args_value (Mapping[str, JsonValue] | None): the value `$ARGS`
            should resolve to, bound the same way and for the same reason
            (libjq's binding defines no `$ARGS` of its own).
        inputs_error (str | None): the parse error the stream ends in,
            which `input` and `inputs` raise past the last of `inputs`.

    Raises:
        JqCompileError: libjq's refusal of the program, its compile
            errors numbered by the program's own lines.
    """
    bound = _value_bound(
        obj, expr, named_args, inputs, args_value, inputs_error
    )
    return _run(expr, bound, False)


def jq_run_texts(
    doc: str,
    expr: str,
    named: Mapping[str, str] | None = None,
    inputs: Sequence[str] | None = None,
    args: str | None = None,
    inputs_error: str | None = None,
    env: str | None = None,
) -> JqRun[str]:
    """Run a jq program on one document the way jq_run does, with the
    document, the bindings and the outputs all JSON text: jq's parser
    reads the text, so a number keeps its literal and an object its key
    order, and each output comes back as jq's own compact dump of it, the
    spelling jq prints (`1.000`, `1E+2`, `1e+17`, `-0`).

    Args:
        doc (str): the document the program runs on.
        expr (str): jq program text.
        named (Mapping[str, str] | None): $name bindings.
        inputs (Sequence[str] | None): the documents still unread.
        args (str | None): the value `$ARGS` should resolve to.
        inputs_error (str | None): the parse error the stream ends in.
        env (str | None): the environment `$ENV` and `env` read in place
            of the process's.

    Raises:
        JqCompileError: libjq's refusal of the program, its compile
            errors numbered by the program's own lines.
    """
    run = _run(
        expr,
        _bound(doc, expr, named, inputs, args, inputs_error, env),
        True,
    )
    # A dumped run hands back strings only (see _collected).
    return cast("JqRun[str]", run)


def jq_raised(
    obj: JsonValue,
    expr: str,
    run: JqRun[JsonValue],
    named_args: Mapping[str, JsonValue] | None = None,
    inputs: Sequence[JsonValue] | None = None,
    args_value: Mapping[str, JsonValue] | None = None,
) -> bool:
    """Whether the program's own `error` raised the error a run stopped at,
    rather than a builtin, which jq itself never tells apart but gojq does.

    Every builtin raises a string, so an error that is not one is the
    program's. A string is the program's only when it calls `error` at
    all, and then only when a rerun that tells the program's own errors
    apart shows it (see _WRAP and _MARK); a run neither rerun can speak
    for reads as a builtin's.

    Args:
        obj (JsonValue): the value the program ran on.
        expr (str): jq program text.
        run (JqRun[JsonValue]): what jq_run returned for them.
        named_args (Mapping[str, JsonValue] | None): $name bindings.
        inputs (Sequence[JsonValue] | None): the unread documents.
        args_value (Mapping[str, JsonValue] | None): the value of `$ARGS`.
    """
    if not isinstance(run.stop, JqError):
        return False
    if not run.stop.string:
        return True
    renamed = _renamed(expr)
    if renamed == expr:
        return False
    bound = _value_bound(obj, expr, named_args, inputs, args_value)
    compiled = _wrapped(renamed, bound, _WRAP, f"{_UNWRAP}){_DONE}")
    if compiled is not None:
        verdict = _wrapped_verdict(compiled.input_text(bound.stdin), run)
        if verdict is not None:
            return verdict
    compiled = _wrapped(renamed, bound, _MARK, f"{_CATCH}){_DONE}")
    if compiled is None:
        return False
    return _marked_verdict(compiled.input_text(bound.stdin), run) is True


def jq_check(
    expr: str,
    named: Mapping[str, str] | None = None,
    inputs: Sequence[str] | None = None,
    args: str | None = None,
) -> None:
    """Compile a program the way a run would, without running it.

    jq compiles its program before it reads any input, so it refuses a
    bad one even when there is no document to run it on.

    Args:
        expr (str): jq program text.
        named (Mapping[str, str] | None): $name bindings, as text.
        inputs (Sequence[str] | None): the unread documents.
        args (str | None): the value of `$ARGS`.

    Raises:
        JqCompileError: libjq's refusal of the program.
    """
    bound = _bound("null", expr, named, inputs, args)
    if _wrapped(expr, bound, "", f"{_CATCH}){_DONE} {_DUMP}") is None:
        _typed(expr, bound, True)


def jq_eval(
    obj: JsonValue,
    expr: str,
    named_args: Mapping[str, JsonValue] | None = None,
    inputs: Sequence[JsonValue] | None = None,
    args_value: Mapping[str, JsonValue] | None = None,
) -> list[JsonValue]:
    """Every output of a jq program on one value (see jq_run), for a
    caller that treats an error as a failure of its own.

    Args:
        obj (JsonValue): the value the program runs on.
        expr (str): jq program text.
        named_args (Mapping[str, JsonValue] | None): $name bindings.
        inputs (Sequence[JsonValue] | None): the unread documents.
        args_value (Mapping[str, JsonValue] | None): the value of `$ARGS`.

    Raises:
        ValueError: libjq's refusal of the program, or the error that
            ended the run.
    """
    run = jq_run(obj, expr, named_args, inputs, args_value)
    if isinstance(run.stop, JqError):
        raise ValueError(run.stop.text)
    return run.outputs
