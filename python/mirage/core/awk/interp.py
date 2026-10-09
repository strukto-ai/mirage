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

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import partial

from mirage.core.awk.builtins import (
    match_position,
    next_random,
    safe_exp,
    safe_fmod,
    safe_log,
    safe_pow,
    safe_sqrt,
    safe_trig,
    split_assignment,
    split_record,
    sprintf,
    substitute,
    substr,
)
from mirage.core.awk.errors import AwkIOError, AwkRuntimeError, AwkSyntaxError
from mirage.core.awk.nodes import (
    ArrayRef,
    Assign,
    Binary,
    Block,
    Break,
    BuiltinCall,
    Call,
    Compare,
    Concat,
    Continue,
    Delete,
    DoWhile,
    Exit,
    Expr,
    ExprStmt,
    Field,
    For,
    ForIn,
    Getline,
    GetlineKind,
    If,
    InArray,
    IncDec,
    Logical,
    MatchOp,
    Next,
    NextFile,
    Not,
    Num,
    Print,
    Printf,
    Program,
    RedirKind,
    Regex,
    Return,
    Rule,
    RuleKind,
    Stmt,
    Str,
    Ternary,
    Unary,
    Var,
    While,
)
from mirage.core.awk.reader import RecordReader
from mirage.core.awk.regex import compile_ere
from mirage.core.awk.types import AwkHost
from mirage.core.awk.value import (
    UNINIT,
    Value,
    ValueKind,
    compare,
    format_num,
    is_true,
    num,
    strnum,
    text,
    to_int,
    to_num,
    to_str,
)
from mirage.shell.bytes import byte_view, from_byte_view

SCALAR_DEFAULTS = {
    "FS": " ",
    "OFS": " ",
    "ORS": "\n",
    "RS": "\n",
    "SUBSEP": "\x1c",
    "CONVFMT": "%.6g",
    "OFMT": "%.6g",
    "FILENAME": "",
    "RSTART": "0",
    "RLENGTH": "-1",
}

COUNTERS = frozenset({"NR", "FNR", "NF"})

STDOUT_NAMES = frozenset({"/dev/stdout", "-"})
STDERR_NAME = "/dev/stderr"
PROGRAM_NAME = "awk"

MAX_CALL_DEPTH = 100


class NextRecord(Exception):
    pass


class NextFileSignal(Exception):
    pass


class BreakLoop(Exception):
    pass


class ContinueLoop(Exception):
    pass


class ReturnValue(Exception):
    def __init__(self, value: Value) -> None:
        super().__init__()
        self.value = value


class ExitProgram(Exception):
    def __init__(self, code: int) -> None:
        super().__init__()
        self.code = code


@dataclass
class Frame:
    params: frozenset[str]
    scalars: dict[str, Value] = field(default_factory=dict)
    tables: dict[str, dict[str, Value]] = field(default_factory=dict)


@dataclass
class InputPipe:
    """A ``cmd | getline`` stream: the command's output and its status.

    Args:
        reader (RecordReader): the records of what the command printed.
        status (int): its exit status, which ``close(cmd)`` returns.
    """

    reader: RecordReader
    status: int


class Interpreter:
    """Run one awk program against the streams its host opens.

    Every stream the program names goes through ``host``: the main input
    operands, ``getline < file``, output files and the command pipes.
    Output is buffered the way mawk 1.3.4 buffers it: standard output
    waits while an output pipe is open, since the pipe's command runs
    when it is closed and what it prints comes first; running any
    command (a new pipe, ``system()``) flushes it, as mawk flushes before
    it forks.

    Args:
        program (Program): the parsed program.
        host (AwkHost): the entry points to files and commands.
        argv (Sequence[str]): the operands as typed, ARGV[1] onward.
        assignments (dict[str, str] | None): the ``-v`` assignments.
        environ (Mapping[str, str] | None): the exported environment,
            which ENVIRON holds; writing ENVIRON reaches no command.
    """

    def __init__(
        self,
        program: Program,
        host: AwkHost,
        argv: Sequence[str] = (),
        assignments: dict[str, str] | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self.program = program
        self.host = host
        self.globals: dict[str, Value] = {}
        self.tables: dict[str, dict[str, Value]] = {}
        self.frames: list[Frame] = []
        self.out: list[bytes] = []
        self.held: list[bytes] = []
        self.err: list[bytes] = []
        self.out_files: dict[str, list[str]] = {}
        self.out_pipes: dict[str, list[str]] = {}
        self.in_files: dict[str, RecordReader] = {}
        self.in_pipes: dict[str, InputPipe] = {}
        self.main: RecordReader | None = None
        self.main_name = ""
        self.arg_index = 0
        self.read_operand = False
        self.record = ""
        self.record_fs = " "
        self.record_paragraph = False
        self.fields: list[str] | None = []
        self.record_stale = False
        self.nr = 0
        self.fnr = 0
        self.range_active: dict[int, bool] = {}
        self.exit_code = 0
        self.rand_state = 0
        self.seed = 0
        for name, value in SCALAR_DEFAULTS.items():
            self.globals[name] = text(value)
        for name, raw in (assignments or {}).items():
            self.globals[name] = strnum(raw)
        self.tables["ARGV"] = {"0": text(PROGRAM_NAME)}
        for position, operand in enumerate(argv, 1):
            self.tables["ARGV"][str(position)] = strnum(operand)
        self.globals["ARGC"] = num(len(argv) + 1)
        self.tables["ENVIRON"] = {
            name: strnum(value) for name, value in (environ or {}).items()
        }

    def special(self, name: str) -> str:
        return to_str(self.globals.get(name, UNINIT), "%.6g")

    def convfmt(self) -> str:
        return self.special("CONVFMT")

    def out_str(self, value: Value) -> str:
        """Render a value for print, which uses OFMT rather than CONVFMT.

        Args:
            value (Value): the value to render.
        """
        if value.kind is ValueKind.NUM:
            return format_num(value.num, self.special("OFMT"))
        return to_str(value, self.convfmt())

    def ensure_fields(self) -> list[str]:
        if self.fields is None:
            self.fields = split_record(
                self.record, self.record_fs, self.record_paragraph
            )
        return self.fields

    def ensure_record(self) -> str:
        if self.record_stale:
            self.record = self.special("OFS").join(self.ensure_fields())
            self.record_stale = False
        return self.record

    def set_record(self, value: str) -> None:
        """Install a new $0, invalidating the split fields.

        The record splits with the FS and RS in force when it arrived, so
        an action that assigns either changes the next record, not this
        one.

        Args:
            value (str): the new record text.
        """
        self.record = value
        self.record_fs = self.special("FS")
        self.record_paragraph = self.special("RS") == ""
        self.fields = None
        self.record_stale = False

    def get_field(self, index: int) -> Value:
        """Read a field by number, with 0 meaning the whole record.

        Args:
            index (int): the field number.
        """
        if index == 0:
            return strnum(self.ensure_record())
        if index < 0:
            raise AwkRuntimeError(f"awk: trying to access field {index}")
        fields = self.ensure_fields()
        if index > len(fields):
            return text("")
        return strnum(fields[index - 1])

    def set_field(self, index: int, value: str) -> None:
        """Write a field, rebuilding $0 or resplitting as POSIX requires.

        Args:
            index (int): the field number, 0 for the whole record.
            value (str): the new text.
        """
        if index == 0:
            self.set_record(value)
            return
        if index < 0:
            raise AwkRuntimeError(f"awk: trying to access field {index}")
        fields = self.ensure_fields()
        while len(fields) < index:
            fields.append("")
        fields[index - 1] = value
        self.record_stale = True

    def set_nf(self, count: int) -> None:
        """Resize the field list, which rebuilds $0 with OFS.

        Args:
            count (int): the new NF.
        """
        fields = self.ensure_fields()
        target = max(count, 0)
        while len(fields) < target:
            fields.append("")
        del fields[target:]
        self.record_stale = True

    def start_file(self, name: str) -> None:
        """Begin a new input file, setting FILENAME and restarting FNR.

        FNR counts records within the current file, so it resets per
        operand while NR keeps running. Range patterns keyed on FNR
        depend on this, as does printing FILENAME.

        Args:
            name (str): the operand as it was typed on the command line.
        """
        self.globals["FILENAME"] = text(name)
        self.main_name = name
        self.fnr = 0

    def reader(self, source: str, index: int | None) -> RecordReader:
        """Open a record reader over one named input stream.

        Args:
            source (str): the stream's name.
            index (int | None): its ARGV slot, None for getline.
        """
        return RecordReader(
            self.host.open_input(source, index), partial(self.special, "RS")
        )

    async def open_operand(self) -> bool:
        """Advance the main input to the next operand that names a file.

        ARGV is read as it stands when each operand is reached, as POSIX
        requires: an emptied or deleted slot is skipped, a ``var=value``
        slot is assigned there, and a slot the program filled is read.
        With no file operand at all the main input is stdin, named ``-``
        in FILENAME (mawk 1.3.4). Returns whether there was one more
        stream to read.
        """
        argv = self.tables.setdefault("ARGV", {})
        while self.arg_index + 1 < to_int(to_num(self.get_var("ARGC"))):
            self.arg_index += 1
            slot = argv.get(str(self.arg_index))
            if slot is None:
                continue
            operand = to_str(slot, self.convfmt())
            if operand == "":
                continue
            assignment = split_assignment(operand)
            if assignment is not None:
                self.set_var(assignment[0], strnum(assignment[1]))
                continue
            self.read_operand = True
            self.start_file(operand)
            self.main = self.reader(operand, self.arg_index)
            return True
        if self.read_operand:
            return False
        self.read_operand = True
        self.start_file("-")
        self.main = self.reader("-", None)
        return True

    async def next_record(self) -> str | None:
        """Read the next main-input record, counting it in NR and FNR.

        This is what the main loop and a plain ``getline`` both read, so
        a getline takes the record the next cycle would have seen, and
        crosses into the next operand the same way. An operand that
        cannot be opened ends the run (mawk 1.3.4, exit 2).
        """
        while True:
            if self.main is not None:
                try:
                    record = await self.main.next()
                except AwkIOError as exc:
                    raise AwkRuntimeError(
                        f'awk: cannot open "{self.main_name}" ({exc.detail})'
                    ) from exc
                if record is not None:
                    self.nr += 1
                    self.fnr += 1
                    return record
                await self.main.close()
                self.main = None
            if not await self.open_operand():
                return None

    async def skip_file(self) -> None:
        """Abandon the rest of the current operand, as nextfile does."""
        if self.main is not None:
            await self.main.close()
            self.main = None

    def frame(self) -> Frame | None:
        return self.frames[-1] if self.frames else None

    def get_var(self, name: str) -> Value:
        """Read a variable, honouring function-local parameters.

        Args:
            name (str): the variable name.
        """
        frame = self.frame()
        if frame is not None and name in frame.params:
            return frame.scalars.get(name, UNINIT)
        if name == "NF":
            return num(len(self.ensure_fields()))
        if name == "NR":
            return num(self.nr)
        if name == "FNR":
            return num(self.fnr)
        return self.globals.get(name, UNINIT)

    def set_var(self, name: str, value: Value) -> None:
        """Write a variable, applying the side effects of the specials.

        Args:
            name (str): the variable name.
            value (Value): the new value.
        """
        frame = self.frame()
        if frame is not None and name in frame.params:
            frame.scalars[name] = value
            return
        if name == "NF":
            self.set_nf(to_int(to_num(value)))
            return
        if name == "NR":
            self.nr = to_int(to_num(value))
            return
        if name == "FNR":
            self.fnr = to_int(to_num(value))
            return
        self.globals[name] = value

    def get_array(self, name: str) -> dict[str, Value]:
        """Resolve an array by name, creating it when first used.

        Args:
            name (str): the array name.
        """
        frame = self.frame()
        if frame is not None and name in frame.params:
            return frame.tables.setdefault(name, {})
        return self.tables.setdefault(name, {})

    async def subscript(self, subs: tuple[Expr, ...]) -> str:
        """Join subscript expressions into a single array key.

        Args:
            subs (tuple[Expr, ...]): the subscript expressions.
        """
        sep = self.special("SUBSEP")
        keys = [
            to_str(self.leaf(s) or await self.eval(s), self.convfmt())
            for s in subs
        ]
        return sep.join(keys)

    async def regex_source(self, node: Expr) -> str:
        """Read the ERE text of a node used in a regex position.

        Args:
            node (Expr): a Regex literal or an expression yielding one.
        """
        if isinstance(node, Regex):
            return node.pattern
        return to_str(await self.eval(node), self.convfmt())

    def leaf(self, node: Expr) -> Value | None:
        """Read a node that cannot suspend without scheduling a coroutine.

        A constant, a variable or a constant field answers here; any
        other node answers None and goes through ``eval``.

        Args:
            node (Expr): the expression.
        """
        if isinstance(node, Num):
            return num(node.value)
        if isinstance(node, Str):
            return text(node.value)
        if isinstance(node, Var):
            return self.get_var(node.name)
        if isinstance(node, Field) and isinstance(node.index, Num):
            return self.get_field(to_int(node.index.value))
        return None

    async def eval(self, node: Expr) -> Value:
        """Evaluate an expression node.

        Args:
            node (Expr): the expression to evaluate.
        """
        if isinstance(node, Num):
            return num(node.value)
        if isinstance(node, Str):
            return text(node.value)
        if isinstance(node, Regex):
            return num(
                1.0
                if compile_ere(node.pattern).search(self.ensure_record())
                else 0.0
            )
        if isinstance(node, Var):
            return self.get_var(node.name)
        if isinstance(node, Field):
            index = self.leaf(node.index) or await self.eval(node.index)
            return self.get_field(to_int(to_num(index)))
        if isinstance(node, ArrayRef):
            array = self.get_array(node.name)
            key = await self.subscript(node.subscripts)
            return array.setdefault(key, UNINIT)
        if isinstance(node, Assign):
            return await self.eval_assign(node)
        if isinstance(node, Binary):
            return await self.eval_binary(node)
        if isinstance(node, Unary):
            value = to_num(await self.eval(node.operand))
            return num(-value if node.op == "-" else value)
        if isinstance(node, Not):
            return num(0.0 if is_true(await self.eval(node.operand)) else 1.0)
        if isinstance(node, Concat):
            left = self.leaf(node.left) or await self.eval(node.left)
            right = self.leaf(node.right) or await self.eval(node.right)
            return text(
                to_str(left, self.convfmt()) + to_str(right, self.convfmt())
            )
        if isinstance(node, Compare):
            return await self.eval_compare(node)
        if isinstance(node, MatchOp):
            subject = to_str(await self.eval(node.left), self.convfmt())
            pattern = await self.regex_source(node.right)
            found = compile_ere(pattern).search(subject) is not None
            return num(1.0 if found != node.negated else 0.0)
        if isinstance(node, Logical):
            return await self.eval_logical(node)
        if isinstance(node, Ternary):
            cond = is_true(await self.eval(node.cond))
            return await self.eval(node.then if cond else node.other)
        if isinstance(node, IncDec):
            return await self.eval_incdec(node)
        if isinstance(node, InArray):
            array = self.get_array(node.name)
            key = await self.subscript(node.subscripts)
            return num(1.0 if key in array else 0.0)
        if isinstance(node, BuiltinCall):
            return await self.eval_builtin(node)
        if isinstance(node, Call):
            return await self.call_function(node)
        if isinstance(node, Getline):
            return await self.eval_getline(node)
        raise AwkRuntimeError(f"awk: cannot evaluate {type(node).__name__}")

    async def eval_getline(self, node: Getline) -> Value:
        """Read one record into $0 or a variable: 1, 0 at EOF, -1 on error.

        A plain getline reads the main input and counts NR and FNR; a
        file or a command does not, as in mawk 1.3.4, which leaves NR
        alone for ``cmd | getline`` too. A file that cannot be opened or
        read answers -1 without a message.

        Args:
            node (Getline): the getline expression.
        """
        if node.kind is GetlineKind.PLAIN:
            record = await self.next_record()
        else:
            assert node.source is not None
            name = to_str(await self.eval(node.source), self.convfmt())
            if node.kind is GetlineKind.FILE:
                reader = self.in_files.get(name)
                if reader is None:
                    reader = self.reader(name, None)
                    self.in_files[name] = reader
                try:
                    record = await reader.next()
                except AwkIOError:
                    del self.in_files[name]
                    return num(-1)
            else:
                record = await (await self.input_pipe(name)).reader.next()
        if record is None:
            return num(0)
        if node.target is None:
            self.set_record(record)
        else:
            await self.assign_to(node.target, strnum(record))
        return num(1)

    async def input_pipe(self, command: str) -> InputPipe:
        """The stream ``command | getline`` reads, running it on first use.

        Args:
            command (str): the command line.
        """
        pipe = self.in_pipes.get(command)
        if pipe is None:
            await self.before_command()
            run = await self.host.run(command, None)
            self.err.append(run.stderr)
            pipe = InputPipe(
                RecordReader(run.stdout, partial(self.special, "RS")),
                run.status,
            )
            self.in_pipes[command] = pipe
        return pipe

    async def eval_logical(self, node: Logical) -> Value:
        left = is_true(await self.eval(node.left))
        if node.op == "&&":
            if not left:
                return num(0.0)
            return num(1.0 if is_true(await self.eval(node.right)) else 0.0)
        if left:
            return num(1.0)
        return num(1.0 if is_true(await self.eval(node.right)) else 0.0)

    async def eval_compare(self, node: Compare) -> Value:
        left = self.leaf(node.left) or await self.eval(node.left)
        right = self.leaf(node.right) or await self.eval(node.right)
        order = compare(left, right, self.convfmt())
        if node.op == "<":
            hit = order < 0
        elif node.op == "<=":
            hit = order <= 0
        elif node.op == ">":
            hit = order > 0
        elif node.op == ">=":
            hit = order >= 0
        elif node.op == "==":
            hit = order == 0
        else:
            hit = order != 0
        return num(1.0 if hit else 0.0)

    async def eval_binary(self, node: Binary) -> Value:
        lhs = to_num(self.leaf(node.left) or await self.eval(node.left))
        rhs = to_num(self.leaf(node.right) or await self.eval(node.right))
        if node.op == "+":
            return num(lhs + rhs)
        if node.op == "-":
            return num(lhs - rhs)
        if node.op == "*":
            return num(lhs * rhs)
        if node.op == "/":
            if rhs == 0:
                raise AwkRuntimeError("awk: division by zero")
            return num(lhs / rhs)
        if node.op == "%":
            if rhs == 0:
                raise AwkRuntimeError("awk: division by zero in %")
            return num(safe_fmod(lhs, rhs))
        return num(safe_pow(lhs, rhs))

    async def assign_to(self, target: Expr, value: Value) -> Value:
        """Store a value into an lvalue node.

        Args:
            target (Expr): a Var, Field or ArrayRef node.
            value (Value): the value to store.
        """
        if isinstance(target, Var):
            self.set_var(target.name, value)
            return value
        if isinstance(target, Field):
            held = self.leaf(target.index) or await self.eval(target.index)
            index = to_int(to_num(held))
            self.set_field(index, to_str(value, self.convfmt()))
            return value
        if isinstance(target, ArrayRef):
            array = self.get_array(target.name)
            array[await self.subscript(target.subscripts)] = value
            return value
        raise AwkRuntimeError("awk: assignment to a non-lvalue")

    async def eval_assign(self, node: Assign) -> Value:
        if node.op == "=":
            value = self.leaf(node.value) or await self.eval(node.value)
            return await self.assign_to(node.target, value)
        current = to_num(
            self.leaf(node.target) or await self.eval(node.target)
        )
        operand = to_num(self.leaf(node.value) or await self.eval(node.value))
        if node.op == "+=":
            result = current + operand
        elif node.op == "-=":
            result = current - operand
        elif node.op == "*=":
            result = current * operand
        elif node.op == "/=":
            if operand == 0:
                raise AwkRuntimeError("awk: division by zero in /=")
            result = current / operand
        elif node.op == "%=":
            if operand == 0:
                raise AwkRuntimeError("awk: division by zero in %=")
            result = safe_fmod(current, operand)
        else:
            result = safe_pow(current, operand)
        return await self.assign_to(node.target, num(result))

    async def eval_incdec(self, node: IncDec) -> Value:
        current = to_num(
            self.leaf(node.target) or await self.eval(node.target)
        )
        updated = current + (1.0 if node.op == "++" else -1.0)
        await self.assign_to(node.target, num(updated))
        return num(updated if node.pre else current)

    async def str_arg(self, node: Expr) -> str:
        return to_str(await self.eval(node), self.convfmt())

    async def eval_builtin(self, node: BuiltinCall) -> Value:
        name = node.name
        args = node.args
        if name == "length":
            return await self.builtin_length(args)
        if name in ("sin", "cos"):
            return num(safe_trig(to_num(await self.eval(args[0])), name))
        if name == "exp":
            return num(safe_exp(to_num(await self.eval(args[0]))))
        if name == "sqrt":
            return num(safe_sqrt(to_num(await self.eval(args[0]))))
        if name == "log":
            return num(safe_log(to_num(await self.eval(args[0]))))
        if name == "int":
            value = to_num(await self.eval(args[0]))
            if math.isnan(value) or math.isinf(value):
                return num(value)
            return num(float(to_int(value)))
        if name == "atan2":
            left = to_num(await self.eval(args[0]))
            right = to_num(await self.eval(args[1]))
            return num(math.atan2(left, right))
        if name == "rand":
            self.rand_state, drawn = next_random(self.rand_state)
            return num(drawn)
        if name == "srand":
            previous = self.seed
            self.seed = to_int(to_num(await self.eval(args[0]))) if args else 0
            self.rand_state = self.seed & 0xFFFFFFFF
            return num(previous)
        if name == "index":
            haystack = await self.str_arg(args[0])
            needle = await self.str_arg(args[1])
            return num(haystack.find(needle) + 1)
        if name == "substr":
            subject = await self.str_arg(args[0])
            start = to_num(await self.eval(args[1]))
            span = to_num(await self.eval(args[2])) if len(args) > 2 else None
            return text(substr(subject, start, span))
        if name == "toupper":
            raw = from_byte_view(await self.str_arg(args[0]))
            return text(byte_view(raw.upper()))
        if name == "tolower":
            raw = from_byte_view(await self.str_arg(args[0]))
            return text(byte_view(raw.lower()))
        if name == "sprintf":
            fmt = await self.str_arg(args[0])
            rest = [await self.eval(a) for a in args[1:]]
            return text(sprintf(fmt, rest, self.convfmt()))
        if name == "match":
            subject = await self.str_arg(args[0])
            pattern = await self.regex_source(args[1])
            start, length = match_position(pattern, subject)
            self.globals["RSTART"] = num(start)
            self.globals["RLENGTH"] = num(length)
            return num(start)
        if name in ("sub", "gsub"):
            return await self.builtin_sub(node, name == "gsub")
        if name == "split":
            return await self.builtin_split(args)
        if name == "close":
            return num(await self.close_stream(await self.str_arg(args[0])))
        if name == "fflush":
            target = await self.str_arg(args[0]) if args else None
            return num(await self.fflush(target))
        if name == "system":
            return num(await self.system(await self.str_arg(args[0])))
        raise AwkRuntimeError(f"awk: calling undefined function {name}")

    async def builtin_length(self, args: tuple[Expr, ...]) -> Value:
        if not args:
            return num(len(self.ensure_record()))
        target = args[0]
        if isinstance(target, Var):
            frame = self.frame()
            local = frame is not None and target.name in frame.params
            known = (
                frame.tables if local and frame is not None else self.tables
            )
            if target.name in known:
                return num(len(known[target.name]))
        return num(len(await self.str_arg(target)))

    async def builtin_sub(self, node: BuiltinCall, globally: bool) -> Value:
        args = node.args
        pattern = await self.regex_source(args[0])
        template = await self.str_arg(args[1])
        target: Expr = args[2] if len(args) > 2 else Field(Num(0.0))
        subject = await self.str_arg(target)
        count, result = substitute(pattern, template, subject, globally)
        if count:
            await self.assign_to(target, text(result))
        return num(count)

    async def builtin_split(self, args: tuple[Expr, ...]) -> Value:
        subject = await self.str_arg(args[0])
        holder = args[1]
        if not isinstance(holder, (Var, ArrayRef)):
            raise AwkRuntimeError("awk: split() needs an array")
        name = holder.name
        array = self.get_array(name)
        array.clear()
        if len(args) > 2:
            separator = await self.regex_source(args[2])
        else:
            separator = self.special("FS")
        parts = split_record(subject, separator)
        for position, part in enumerate(parts, 1):
            array[str(position)] = strnum(part)
        return num(len(parts))

    async def call_function(self, node: Call) -> Value:
        definition = self.program.functions.get(node.name)
        if definition is None:
            raise AwkRuntimeError(
                f"awk: calling undefined function {node.name}"
            )
        if len(self.frames) >= MAX_CALL_DEPTH:
            raise AwkRuntimeError(
                f"awk: function {node.name} nested deeper than "
                f"{MAX_CALL_DEPTH} calls"
            )
        frame = Frame(frozenset(definition.params))
        for position, param in enumerate(definition.params):
            if position >= len(node.args):
                continue
            argument = node.args[position]
            if isinstance(argument, Var) and self.is_array_name(argument.name):
                frame.tables[param] = self.get_array(argument.name)
            else:
                frame.scalars[param] = await self.eval(argument)
        self.frames.append(frame)
        try:
            await self.exec_stmt(definition.body)
        except ReturnValue as returned:
            return returned.value
        finally:
            self.frames.pop()
        return UNINIT

    def is_array_name(self, name: str) -> bool:
        """Report whether a bare name should be passed as an array.

        A name already holding an array is one; so is a name that has
        never been used at all, since the callee may subscript it.

        Args:
            name (str): the candidate variable name.
        """
        frame = self.frame()
        if frame is not None and name in frame.params:
            if name in frame.tables:
                return True
            return name not in frame.scalars
        if name in self.tables:
            return True
        return name not in self.globals and name not in COUNTERS

    def stdout(self, body: str) -> None:
        """Buffer text for standard output.

        While an output pipe is open the text waits, since the pipe's
        command prints ahead of it when it runs; once held, later text
        waits behind it.

        Args:
            body (str): the text.
        """
        if self.out_pipes or self.held:
            self.held.append(from_byte_view(body))
        else:
            self.out.append(from_byte_view(body))

    def release(self) -> None:
        """Let held standard output go, as a flush of stdout does."""
        self.out.extend(self.held)
        self.held.clear()

    async def write_file(self, name: str, body: str, append: bool) -> None:
        """Write through the host, a failure ending the run.

        Args:
            name (str): the file name.
            body (str): the text.
            append (bool): append rather than replace.
        """
        try:
            await self.host.write_file(name, body, append)
        except AwkIOError as exc:
            raise AwkRuntimeError(
                f'awk: cannot open "{name}" for output ({exc.detail})'
            ) from exc

    async def flush_file(self, name: str) -> None:
        """Write out what one output file has buffered.

        Args:
            name (str): the file name.
        """
        pending = self.out_files.get(name)
        if pending:
            body = "".join(pending)
            pending.clear()
            await self.write_file(name, body, True)

    async def flush_files(self) -> None:
        """Write out what every output file has buffered."""
        for name in list(self.out_files):
            await self.flush_file(name)

    async def before_command(self) -> None:
        """Flush what a command about to run must see.

        mawk flushes its output before it forks, so the command reads
        the files awk wrote and prints after awk's standard output.
        """
        await self.flush_files()
        self.release()

    async def write(self, body: str, node: Print | Printf) -> None:
        """Emit output to stdout or to a redirection target.

        A file opened with ``>`` is emptied when it is opened, and what
        is printed to it is buffered until a flush, a close or the end of
        the record, so reading it back before closing it reads what was
        flushed.

        Args:
            body (str): the text to write.
            node (Print | Printf): the statement carrying the redirect.
        """
        redirect = node.redirect
        if redirect is None:
            self.stdout(body)
            return
        name = to_str(await self.eval(redirect.target), self.convfmt())
        if redirect.kind == RedirKind.PIPE:
            pipe = self.out_pipes.get(name)
            if pipe is None:
                await self.before_command()
                pipe = self.out_pipes[name] = []
            pipe.append(body)
            return
        if name in STDOUT_NAMES:
            self.stdout(body)
            return
        if name == STDERR_NAME:
            self.err.append(from_byte_view(body))
            return
        pending = self.out_files.get(name)
        if pending is None:
            if redirect.kind == RedirKind.FILE:
                await self.write_file(name, "", False)
            pending = self.out_files[name] = []
        pending.append(body)

    async def close_out_pipe(self, command: str) -> int:
        """Run an output pipe's command on everything printed to it.

        Args:
            command (str): the command line.
        """
        body = "".join(self.out_pipes.pop(command))
        await self.flush_files()
        run = await self.host.run(command, from_byte_view(body))
        self.out.append(run.stdout)
        self.err.append(run.stderr)
        return run.status

    async def close_stream(self, name: str) -> int:
        """Close whatever the program opened under a name.

        A command answers its exit status, a file 0, and a name nothing
        is open under -1.

        Args:
            name (str): the file name or command line.
        """
        status = -1
        if name in self.out_pipes:
            status = await self.close_out_pipe(name)
        pipe = self.in_pipes.pop(name, None)
        if pipe is not None:
            await pipe.reader.close()
            status = pipe.status
        if name in self.out_files:
            await self.flush_file(name)
            del self.out_files[name]
            status = 0
        reader = self.in_files.pop(name, None)
        if reader is not None:
            await reader.close()
            status = 0
        return status

    async def fflush(self, name: str | None) -> int:
        """Flush standard output and files, or one named stream.

        Output pipes run only when closed, so flushing one flushes
        nothing.

        Args:
            name (str | None): the stream, None or "" for all of them.
        """
        if name is None or name == "":
            await self.before_command()
            return 0
        if name in STDOUT_NAMES:
            self.release()
            return 0
        if name in self.out_files:
            await self.flush_file(name)
            return 0
        return 0 if name in self.out_pipes else -1

    async def system(self, command: str) -> int:
        """Run a command line, its output landing after awk's own.

        Args:
            command (str): the command line.
        """
        await self.before_command()
        run = await self.host.run(command, None)
        self.out.append(run.stdout)
        self.err.append(run.stderr)
        return run.status

    async def exec_stmt(self, node: Stmt) -> None:
        """Execute a statement node.

        Args:
            node (Stmt): the statement to run.
        """
        if isinstance(node, Block):
            for inner in node.body:
                await self.exec_stmt(inner)
            return
        if isinstance(node, ExprStmt):
            await self.eval(node.expr)
            return
        if isinstance(node, Print):
            await self.exec_print(node)
            return
        if isinstance(node, Printf):
            values = [await self.eval(a) for a in node.args]
            if not values:
                raise AwkRuntimeError("awk: printf needs a format")
            fmt = to_str(values[0], self.convfmt())
            await self.write(sprintf(fmt, values[1:], self.convfmt()), node)
            return
        if isinstance(node, If):
            if is_true(await self.eval(node.cond)):
                await self.exec_stmt(node.then)
            elif node.other is not None:
                await self.exec_stmt(node.other)
            return
        if isinstance(node, While):
            await self.exec_while(node)
            return
        if isinstance(node, DoWhile):
            await self.exec_do_while(node)
            return
        if isinstance(node, For):
            await self.exec_for(node)
            return
        if isinstance(node, ForIn):
            await self.exec_for_in(node)
            return
        if isinstance(node, Delete):
            await self.exec_delete(node)
            return
        if isinstance(node, Next):
            raise NextRecord()
        if isinstance(node, NextFile):
            raise NextFileSignal()
        if isinstance(node, Break):
            raise BreakLoop()
        if isinstance(node, Continue):
            raise ContinueLoop()
        if isinstance(node, Return):
            value = (
                await self.eval(node.value)
                if node.value is not None
                else UNINIT
            )
            raise ReturnValue(value)
        if isinstance(node, Exit):
            if node.value is not None:
                self.exit_code = to_int(to_num(await self.eval(node.value)))
            raise ExitProgram(self.exit_code)
        raise AwkRuntimeError(f"awk: cannot run {type(node).__name__}")

    async def exec_print(self, node: Print) -> None:
        if node.args:
            parts = [
                self.out_str(self.leaf(a) or await self.eval(a))
                for a in node.args
            ]
            body = self.special("OFS").join(parts)
        else:
            body = self.ensure_record()
        await self.write(body + self.special("ORS"), node)

    async def exec_while(self, node: While) -> None:
        while is_true(await self.eval(node.cond)):
            try:
                await self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                continue

    async def exec_do_while(self, node: DoWhile) -> None:
        while True:
            try:
                await self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                pass
            if not is_true(await self.eval(node.cond)):
                return

    async def exec_for(self, node: For) -> None:
        if node.init is not None:
            await self.exec_stmt(node.init)
        while node.cond is None or is_true(await self.eval(node.cond)):
            try:
                await self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                pass
            if node.post is not None:
                await self.exec_stmt(node.post)

    async def exec_for_in(self, node: ForIn) -> None:
        array = self.get_array(node.array)
        for key in list(array.keys()):
            self.set_var(node.var, strnum(key))
            try:
                await self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                continue

    async def exec_delete(self, node: Delete) -> None:
        array = self.get_array(node.name)
        if node.subscripts is None:
            array.clear()
            return
        array.pop(await self.subscript(node.subscripts), None)

    async def matches_rule(self, rule: Rule, index: int) -> bool:
        """Decide whether a main rule fires for the current record.

        Args:
            rule (Rule): the rule under test.
            index (int): its position, used to key range state.
        """
        if rule.kind is RuleKind.ALWAYS:
            return True
        if rule.kind is RuleKind.PATTERN:
            assert rule.pattern is not None
            return is_true(await self.eval(rule.pattern))
        assert rule.pattern is not None and rule.pattern_end is not None
        if self.range_active.get(index, False):
            if is_true(await self.eval(rule.pattern_end)):
                self.range_active[index] = False
            return True
        if is_true(await self.eval(rule.pattern)):
            self.range_active[index] = not is_true(
                await self.eval(rule.pattern_end)
            )
            return True
        return False

    async def run_begin(self) -> None:
        """Run every BEGIN rule in source order."""
        await self.run_edge(RuleKind.BEGIN)

    async def run_edge(self, kind: RuleKind) -> None:
        """Run the BEGIN or the END rules, where no record is current.

        Args:
            kind (RuleKind): BEGIN or END.
        """
        try:
            for rule in self.program.rules:
                if rule.kind is kind and rule.action is not None:
                    await self.exec_stmt(rule.action)
        except (NextRecord, NextFileSignal) as exc:
            raise AwkRuntimeError(
                f"awk: next used in a {kind.value} action"
            ) from exc

    async def run_record(self, line: str) -> None:
        """Run the main rules against one input record.

        Args:
            line (str): the record text, without its separator, as
                ``next_record`` returned it.
        """
        self.set_record(line)
        try:
            for index, rule in enumerate(self.program.rules):
                if rule.kind in (RuleKind.BEGIN, RuleKind.END):
                    continue
                if not await self.matches_rule(rule, index):
                    continue
                if rule.action is None:
                    await self.write(
                        self.ensure_record() + self.special("ORS"),
                        Print((), None),
                    )
                else:
                    await self.exec_stmt(rule.action)
        except NextRecord:
            return
        except NextFileSignal:
            await self.skip_file()

    async def run_end(self) -> None:
        """Run every END rule in source order."""
        await self.run_edge(RuleKind.END)

    def has_main_rules(self) -> bool:
        """Report whether any rule needs input records."""
        return any(r.kind not in (RuleKind.BEGIN,) for r in self.program.rules)

    async def finish(self) -> None:
        """Close everything at exit, as awk does before it returns.

        The output pipes run newest first, as mawk 1.3.4 closes them,
        and their output lands ahead of any standard output still
        waiting; the files are written out and the inputs let go.
        """
        for command in reversed(list(self.out_pipes)):
            await self.close_out_pipe(command)
        await self.flush_files()
        self.release()
        await self.close_inputs()

    async def close_inputs(self) -> None:
        """Let go of every input stream still open."""
        readers = [pipe.reader for pipe in self.in_pipes.values()]
        readers.extend(self.in_files.values())
        if self.main is not None:
            readers.append(self.main)
        self.in_pipes.clear()
        self.in_files.clear()
        self.main = None
        for reader in readers:
            await reader.close()

    async def drain(self) -> tuple[bytes, bytes]:
        """Take the output ready so far: standard output, then stderr.

        Called between records: the files are written out, and standard
        output held for an output pipe stays held until the pipe closes.
        """
        await self.flush_files()
        if not self.out_pipes:
            self.release()
        return self.take()

    async def salvage(
        self, failure: AwkRuntimeError | AwkSyntaxError
    ) -> tuple[bytes, bytes]:
        """Take what a run a fatal error ended leaves behind.

        What awk had already printed stays, held text included, and so
        does what it had printed to files, but no pipe command runs:
        mawk's exit flushes its buffers and nothing else. The error is
        reported, and after it any file that could not be written now.

        Args:
            failure (AwkRuntimeError | AwkSyntaxError): the fatal error.
        """
        self.err.append(from_byte_view(f"{failure}\n"))
        try:
            await self.flush_files()
        except AwkRuntimeError as exc:
            self.err.append(from_byte_view(f"{exc}\n"))
        self.release()
        return self.take()

    def take(self) -> tuple[bytes, bytes]:
        out = b"".join(self.out)
        err = b"".join(self.err)
        self.out.clear()
        self.err.clear()
        return out, err


__all__ = [
    "ExitProgram",
    "Frame",
    "InputPipe",
    "Interpreter",
]
