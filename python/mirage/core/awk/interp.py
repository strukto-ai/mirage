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
from dataclasses import dataclass, field

from mirage.core.awk.builtins import (match_position, next_random, safe_exp,
                                      safe_fmod, safe_log, safe_pow, safe_sqrt,
                                      safe_trig, split_record, sprintf,
                                      substitute, substr)
from mirage.core.awk.errors import AwkRuntimeError
# yapf: disable
from mirage.core.awk.nodes import Binary  # yapf: disable
from mirage.core.awk.nodes import (ArrayRef, Assign, Block, Break, BuiltinCall,
                                   Call, Compare, Concat, Continue, Delete,
                                   DoWhile, Exit, Expr, ExprStmt, Field, For,
                                   ForIn, Getline, If, InArray, IncDec,
                                   Logical, MatchOp, Next, NextFile, Not, Num,
                                   Print, Printf, Program, RedirKind, Regex,
                                   Return, Rule, RuleKind, Stmt, Str, Ternary,
                                   Unary, Var, While)
# yapf: enable
from mirage.core.awk.regex import compile_ere
from mirage.core.awk.value import (UNINIT, Value, ValueKind, compare,
                                   format_num, is_true, num, strnum, text,
                                   to_int, to_num, to_str)

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

ARITY = {
    "close": 1,
    "atan2": 2,
    "cos": 1,
    "exp": 1,
    "index": 2,
    "int": 1,
    "log": 1,
    "match": 2,
    "sin": 1,
    "split": 2,
    "sprintf": 1,
    "sqrt": 1,
    "sub": 2,
    "gsub": 2,
    "substr": 2,
    "tolower": 1,
    "toupper": 1,
}

STDOUT_NAMES = frozenset({"/dev/stdout", "-"})
STDERR_NAME = "/dev/stderr"

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


class Interpreter:

    def __init__(self,
                 program: Program,
                 assignments: dict[str, str] | None = None) -> None:
        self.program = program
        self.globals: dict[str, Value] = {}
        self.tables: dict[str, dict[str, Value]] = {}
        self.frames: list[Frame] = []
        self.output: list[tuple[str | None, str, bool]] = []
        self.open_files: set[str] = set()
        self.record = ""
        self.record_fs = " "
        self.record_paragraph = False
        self.fields: list[str] | None = []
        self.record_stale = False
        self.nr = 0
        self.fnr = 0
        self.range_active: dict[int, bool] = {}
        self.skip_file = False
        self.exit_code = 0
        self.rand_state = 0
        self.seed = 0
        for name, value in SCALAR_DEFAULTS.items():
            self.globals[name] = text(value)
        for name, raw in (assignments or {}).items():
            self.globals[name] = strnum(raw)

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
            self.fields = split_record(self.record, self.record_fs,
                                       self.record_paragraph)
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
        self.fnr = 0
        self.skip_file = False

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

    def subscript(self, subs: tuple[Expr, ...]) -> str:
        """Join subscript expressions into a single array key.

        Args:
            subs (tuple[Expr, ...]): the subscript expressions.
        """
        sep = self.special("SUBSEP")
        return sep.join(to_str(self.eval(s), self.convfmt()) for s in subs)

    def regex_source(self, node: Expr) -> str:
        """Read the ERE text of a node used in a regex position.

        Args:
            node (Expr): a Regex literal or an expression yielding one.
        """
        if isinstance(node, Regex):
            return node.pattern
        return to_str(self.eval(node), self.convfmt())

    def eval(self, node: Expr) -> Value:
        """Evaluate an expression node.

        Args:
            node (Expr): the expression to evaluate.
        """
        if isinstance(node, Num):
            return num(node.value)
        if isinstance(node, Str):
            return text(node.value)
        if isinstance(node, Regex):
            return num(1.0 if compile_ere(node.pattern).
                       search(self.ensure_record()) else 0.0)
        if isinstance(node, Var):
            return self.get_var(node.name)
        if isinstance(node, Field):
            return self.get_field(to_int(to_num(self.eval(node.index))))
        if isinstance(node, ArrayRef):
            array = self.get_array(node.name)
            return array.setdefault(self.subscript(node.subscripts), UNINIT)
        if isinstance(node, Assign):
            return self.eval_assign(node)
        if isinstance(node, Binary):
            return self.eval_binary(node)
        if isinstance(node, Unary):
            value = to_num(self.eval(node.operand))
            return num(-value if node.op == "-" else value)
        if isinstance(node, Not):
            return num(0.0 if is_true(self.eval(node.operand)) else 1.0)
        if isinstance(node, Concat):
            left = to_str(self.eval(node.left), self.convfmt())
            right = to_str(self.eval(node.right), self.convfmt())
            return text(left + right)
        if isinstance(node, Compare):
            return self.eval_compare(node)
        if isinstance(node, MatchOp):
            subject = to_str(self.eval(node.left), self.convfmt())
            hit = compile_ere(self.regex_source(node.right)).search(subject)
            found = hit is not None
            return num(1.0 if found != node.negated else 0.0)
        if isinstance(node, Logical):
            return self.eval_logical(node)
        if isinstance(node, Ternary):
            branch = node.then if is_true(self.eval(node.cond)) else node.other
            return self.eval(branch)
        if isinstance(node, IncDec):
            return self.eval_incdec(node)
        if isinstance(node, InArray):
            array = self.get_array(node.name)
            return num(1.0 if self.subscript(node.subscripts) in
                       array else 0.0)
        if isinstance(node, BuiltinCall):
            return self.eval_builtin(node)
        if isinstance(node, Call):
            return self.call_function(node)
        if isinstance(node, Getline):
            raise AwkRuntimeError("awk: getline is not supported in mirage")
        raise AwkRuntimeError(f"awk: cannot evaluate {type(node).__name__}")

    def eval_logical(self, node: Logical) -> Value:
        left = is_true(self.eval(node.left))
        if node.op == "&&":
            if not left:
                return num(0.0)
            return num(1.0 if is_true(self.eval(node.right)) else 0.0)
        if left:
            return num(1.0)
        return num(1.0 if is_true(self.eval(node.right)) else 0.0)

    def eval_compare(self, node: Compare) -> Value:
        order = compare(self.eval(node.left), self.eval(node.right),
                        self.convfmt())
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

    def eval_binary(self, node: Binary) -> Value:
        lhs = to_num(self.eval(node.left))
        rhs = to_num(self.eval(node.right))
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

    def assign_to(self, target: Expr, value: Value) -> Value:
        """Store a value into an lvalue node.

        Args:
            target (Expr): a Var, Field or ArrayRef node.
            value (Value): the value to store.
        """
        if isinstance(target, Var):
            self.set_var(target.name, value)
            return value
        if isinstance(target, Field):
            index = to_int(to_num(self.eval(target.index)))
            self.set_field(index, to_str(value, self.convfmt()))
            return value
        if isinstance(target, ArrayRef):
            array = self.get_array(target.name)
            array[self.subscript(target.subscripts)] = value
            return value
        raise AwkRuntimeError("awk: assignment to a non-lvalue")

    def eval_assign(self, node: Assign) -> Value:
        if node.op == "=":
            return self.assign_to(node.target, self.eval(node.value))
        current = to_num(self.eval(node.target))
        operand = to_num(self.eval(node.value))
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
        return self.assign_to(node.target, num(result))

    def eval_incdec(self, node: IncDec) -> Value:
        current = to_num(self.eval(node.target))
        updated = current + (1.0 if node.op == "++" else -1.0)
        self.assign_to(node.target, num(updated))
        return num(updated if node.pre else current)

    def eval_builtin(self, node: BuiltinCall) -> Value:
        name = node.name
        args = node.args
        if name == "length":
            return self.builtin_length(args)
        if name in ARITY and len(args) < ARITY[name]:
            raise AwkRuntimeError(f"awk: not enough arguments to {name}")
        if name in ("sin", "cos"):
            return num(safe_trig(to_num(self.eval(args[0])), name))
        if name == "exp":
            return num(safe_exp(to_num(self.eval(args[0]))))
        if name == "sqrt":
            return num(safe_sqrt(to_num(self.eval(args[0]))))
        if name == "log":
            return num(safe_log(to_num(self.eval(args[0]))))
        if name == "int":
            value = to_num(self.eval(args[0]))
            if math.isnan(value) or math.isinf(value):
                return num(value)
            return num(float(to_int(value)))
        if name == "atan2":
            return num(
                math.atan2(to_num(self.eval(args[0])),
                           to_num(self.eval(args[1]))))
        if name == "rand":
            self.rand_state, drawn = next_random(self.rand_state)
            return num(drawn)
        if name == "srand":
            previous = self.seed
            self.seed = to_int(to_num(self.eval(args[0]))) if args else 0
            self.rand_state = self.seed & 0xFFFFFFFF
            return num(previous)
        if name == "index":
            haystack = to_str(self.eval(args[0]), self.convfmt())
            needle = to_str(self.eval(args[1]), self.convfmt())
            return num(haystack.find(needle) + 1)
        if name == "substr":
            subject = to_str(self.eval(args[0]), self.convfmt())
            start = to_num(self.eval(args[1]))
            span = to_num(self.eval(args[2])) if len(args) > 2 else None
            return text(substr(subject, start, span))
        if name == "toupper":
            return text(to_str(self.eval(args[0]), self.convfmt()).upper())
        if name == "tolower":
            return text(to_str(self.eval(args[0]), self.convfmt()).lower())
        if name == "sprintf":
            fmt = to_str(self.eval(args[0]), self.convfmt())
            rest = [self.eval(a) for a in args[1:]]
            return text(sprintf(fmt, rest, self.convfmt()))
        if name == "match":
            subject = to_str(self.eval(args[0]), self.convfmt())
            start, length = match_position(self.regex_source(args[1]), subject)
            self.globals["RSTART"] = num(start)
            self.globals["RLENGTH"] = num(length)
            return num(start)
        if name in ("sub", "gsub"):
            return self.builtin_sub(node, name == "gsub")
        if name == "split":
            return self.builtin_split(args)
        if name == "close":
            target = to_str(self.eval(args[0]), self.convfmt())
            if target not in self.open_files:
                return num(-1)
            self.open_files.remove(target)
            return num(0)
        if name == "fflush":
            return num(0)
        if name == "system":
            raise AwkRuntimeError("awk: system() is not supported in mirage")
        raise AwkRuntimeError(f"awk: calling undefined function {name}")

    def builtin_length(self, args: tuple[Expr, ...]) -> Value:
        if not args:
            return num(len(self.ensure_record()))
        target = args[0]
        if isinstance(target, Var):
            frame = self.frame()
            local = frame is not None and target.name in frame.params
            known = (frame.tables
                     if local and frame is not None else self.tables)
            if target.name in known:
                return num(len(known[target.name]))
        return num(len(to_str(self.eval(target), self.convfmt())))

    def builtin_sub(self, node: BuiltinCall, globally: bool) -> Value:
        args = node.args
        pattern = self.regex_source(args[0])
        template = to_str(self.eval(args[1]), self.convfmt())
        target: Expr = args[2] if len(args) > 2 else Field(Num(0.0))
        subject = to_str(self.eval(target), self.convfmt())
        count, result = substitute(pattern, template, subject, globally)
        if count:
            self.assign_to(target, text(result))
        return num(count)

    def builtin_split(self, args: tuple[Expr, ...]) -> Value:
        subject = to_str(self.eval(args[0]), self.convfmt())
        holder = args[1]
        if not isinstance(holder, (Var, ArrayRef)):
            raise AwkRuntimeError("awk: split() needs an array")
        name = holder.name
        array = self.get_array(name)
        array.clear()
        if len(args) > 2:
            separator = self.regex_source(args[2])
        else:
            separator = self.special("FS")
        parts = split_record(subject, separator)
        for position, part in enumerate(parts, 1):
            array[str(position)] = strnum(part)
        return num(len(parts))

    def call_function(self, node: Call) -> Value:
        definition = self.program.functions.get(node.name)
        if definition is None:
            raise AwkRuntimeError(
                f"awk: calling undefined function {node.name}")
        if len(self.frames) >= MAX_CALL_DEPTH:
            raise AwkRuntimeError(
                f"awk: function {node.name} nested deeper than "
                f"{MAX_CALL_DEPTH} calls")
        frame = Frame(frozenset(definition.params))
        for position, param in enumerate(definition.params):
            if position >= len(node.args):
                continue
            argument = node.args[position]
            if isinstance(argument, Var) and self.is_array_name(argument.name):
                frame.tables[param] = self.get_array(argument.name)
            else:
                frame.scalars[param] = self.eval(argument)
        self.frames.append(frame)
        try:
            self.exec_stmt(definition.body)
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

    def write(self, body: str, node: Print | Printf) -> None:
        """Emit output to stdout or to a redirection target.

        Args:
            body (str): the text to write.
            node (Print | Printf): the statement carrying the redirect.
        """
        redirect = node.redirect
        if redirect is None:
            self.output.append((None, body, False))
            return
        name = to_str(self.eval(redirect.target), self.convfmt())
        if redirect.kind == RedirKind.PIPE:
            raise AwkRuntimeError(
                "awk: output pipes are not supported in mirage")
        if name in STDOUT_NAMES:
            self.output.append((None, body, False))
            return
        if name == STDERR_NAME:
            self.output.append((STDERR_NAME, body, False))
            return
        append = name in self.open_files or redirect.kind == RedirKind.APPEND
        self.open_files.add(name)
        self.output.append((name, body, append))

    def exec_stmt(self, node: Stmt) -> None:
        """Execute a statement node.

        Args:
            node (Stmt): the statement to run.
        """
        if isinstance(node, Block):
            for inner in node.body:
                self.exec_stmt(inner)
            return
        if isinstance(node, ExprStmt):
            self.eval(node.expr)
            return
        if isinstance(node, Print):
            self.exec_print(node)
            return
        if isinstance(node, Printf):
            values = [self.eval(a) for a in node.args]
            if not values:
                raise AwkRuntimeError("awk: printf needs a format")
            fmt = to_str(values[0], self.convfmt())
            self.write(sprintf(fmt, values[1:], self.convfmt()), node)
            return
        if isinstance(node, If):
            if is_true(self.eval(node.cond)):
                self.exec_stmt(node.then)
            elif node.other is not None:
                self.exec_stmt(node.other)
            return
        if isinstance(node, While):
            self.exec_while(node)
            return
        if isinstance(node, DoWhile):
            self.exec_do_while(node)
            return
        if isinstance(node, For):
            self.exec_for(node)
            return
        if isinstance(node, ForIn):
            self.exec_for_in(node)
            return
        if isinstance(node, Delete):
            self.exec_delete(node)
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
            value = self.eval(node.value) if node.value is not None else UNINIT
            raise ReturnValue(value)
        if isinstance(node, Exit):
            if node.value is not None:
                self.exit_code = to_int(to_num(self.eval(node.value)))
            raise ExitProgram(self.exit_code)
        raise AwkRuntimeError(f"awk: cannot run {type(node).__name__}")

    def exec_print(self, node: Print) -> None:
        if node.args:
            body = self.special("OFS").join(
                self.out_str(self.eval(a)) for a in node.args)
        else:
            body = self.ensure_record()
        self.write(body + self.special("ORS"), node)

    def exec_while(self, node: While) -> None:
        while is_true(self.eval(node.cond)):
            try:
                self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                continue

    def exec_do_while(self, node: DoWhile) -> None:
        while True:
            try:
                self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                pass
            if not is_true(self.eval(node.cond)):
                return

    def exec_for(self, node: For) -> None:
        if node.init is not None:
            self.exec_stmt(node.init)
        while node.cond is None or is_true(self.eval(node.cond)):
            try:
                self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                pass
            if node.post is not None:
                self.exec_stmt(node.post)

    def exec_for_in(self, node: ForIn) -> None:
        array = self.get_array(node.array)
        for key in list(array.keys()):
            self.set_var(node.var, strnum(key))
            try:
                self.exec_stmt(node.body)
            except BreakLoop:
                return
            except ContinueLoop:
                continue

    def exec_delete(self, node: Delete) -> None:
        array = self.get_array(node.name)
        if node.subscripts is None:
            array.clear()
            return
        array.pop(self.subscript(node.subscripts), None)

    def matches_rule(self, rule: Rule, index: int) -> bool:
        """Decide whether a main rule fires for the current record.

        Args:
            rule (Rule): the rule under test.
            index (int): its position, used to key range state.
        """
        if rule.kind is RuleKind.ALWAYS:
            return True
        if rule.kind is RuleKind.PATTERN:
            assert rule.pattern is not None
            return is_true(self.eval(rule.pattern))
        assert rule.pattern is not None and rule.pattern_end is not None
        if self.range_active.get(index, False):
            if is_true(self.eval(rule.pattern_end)):
                self.range_active[index] = False
            return True
        if is_true(self.eval(rule.pattern)):
            self.range_active[index] = not is_true(self.eval(rule.pattern_end))
            return True
        return False

    def run_begin(self) -> None:
        """Run every BEGIN rule in source order."""
        self.run_edge(RuleKind.BEGIN)

    def run_edge(self, kind: RuleKind) -> None:
        """Run the BEGIN or the END rules, where no record is current.

        Args:
            kind (RuleKind): BEGIN or END.
        """
        try:
            for rule in self.program.rules:
                if rule.kind is kind and rule.action is not None:
                    self.exec_stmt(rule.action)
        except (NextRecord, NextFileSignal) as exc:
            raise AwkRuntimeError(
                f"awk: next used in a {kind.value} action") from exc

    def run_record(self, line: str) -> None:
        """Run the main rules against one input record.

        Args:
            line (str): the record text, without its separator.
        """
        self.nr += 1
        self.fnr += 1
        self.set_record(line)
        try:
            for index, rule in enumerate(self.program.rules):
                if rule.kind in (RuleKind.BEGIN, RuleKind.END):
                    continue
                if not self.matches_rule(rule, index):
                    continue
                if rule.action is None:
                    self.write(self.ensure_record() + self.special("ORS"),
                               Print((), None))
                else:
                    self.exec_stmt(rule.action)
        except NextRecord:
            return
        except NextFileSignal:
            # nextfile abandons the rest of the current operand, not just
            # the current record; the driver reads the flag and moves on.
            self.skip_file = True
            return

    def run_end(self) -> None:
        """Run every END rule in source order."""
        self.run_edge(RuleKind.END)

    def has_main_rules(self) -> bool:
        """Report whether any rule needs input records."""
        return any(r.kind not in (RuleKind.BEGIN, )
                   for r in self.program.rules)

    def drain(self) -> str:
        """Take everything buffered for stdout since the last drain."""
        out = "".join(body for name, body, _ in self.output if name is None)
        self.output = [event for event in self.output if event[0] is not None]
        return out

    def drain_err(self) -> str:
        """Take everything written to /dev/stderr since the last drain."""
        out = "".join(body for name, body, _ in self.output
                      if name == STDERR_NAME)
        self.output = [
            event for event in self.output if event[0] != STDERR_NAME
        ]
        return out

    def drain_output(self) -> list[tuple[str | None, str, bool]]:
        """Take ordered output events for the async host to apply."""
        pending, self.output = self.output, []
        return pending


__all__ = [
    "ExitProgram",
    "Frame",
    "Interpreter",
]
