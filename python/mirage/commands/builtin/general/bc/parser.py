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

from . import constants
from .errors import BcHalt, BcParseError, BcRuntimeError, runtime_warning_line
from .lexer import string_end, unescape
from .math import call_function
from .numbers import (
    ZERO,
    apply_binary,
    call_builtin,
    clamp_scale,
    read_base_number,
    truncate_int,
)
from .render import render_number
from .types import BcNumber, BcState


def assignable(name: str) -> bool:
    """Whether `name` can be assigned to or incremented.

    Args:
        name (str): the name read from the input, possibly empty.

    Returns:
        bool: True for a register and for any non-reserved name.
    """
    if name in constants.REGISTERS:
        return True
    return name != "" and name not in constants.RESERVED_WORDS


class Parser:
    """A recursive-descent parser for one bc statement.

    It replaces the `eval()` this command used to run on agent-typed
    text, and mirrors `Parser` in `bc.ts` method for method so the two
    hosts accept and refuse the same lines.

    Args:
        src (str): the statement text.
        state (BcState): the run's registers, symbol table and
            math-library flag.
        writes (list[str]): where the statement's output is appended,
            already rendered. Owned by the caller so that the text a
            statement produced before a runtime error survives it:
            `print "x", 1/0` writes the `x` GNU had already written when
            the division refused.
    """

    __slots__ = ("_src", "_pos", "_state", "_writes")

    def __init__(self, src: str, state: BcState, writes: list[str]) -> None:
        self._src = src
        self._pos = 0
        self._state = state
        self._writes = writes

    def _skip_blanks(self) -> None:
        while (
            self._pos < len(self._src)
            and self._src[self._pos] in constants.BLANKS
        ):
            self._pos += 1

    def _peek(self) -> str:
        self._skip_blanks()
        if self._pos < len(self._src):
            return self._src[self._pos]
        return ""

    def _consume(self) -> str:
        char = self._peek()
        self._pos += 1
        return char

    def _match(self, text: str) -> bool:
        self._skip_blanks()
        if self._src.startswith(text, self._pos):
            self._pos += len(text)
            return True
        return False

    def unexpected(self) -> BcParseError:
        """The diagnostic for whatever sits at the cursor.

        Returns:
            BcParseError: an illegal-character report for a character
                GNU's lexer has no rule for, otherwise a syntax error,
                marked incomplete when the input simply ran out.
        """
        char = self._peek()
        # A `"` the input never closes matches no lexer rule either, so it
        # is an illegal character where a closed one is an ordinary token
        # in the wrong place: `1+"a` reports the quote and `1+"a"` a
        # syntax error.
        if (
            char == constants.STRING_QUOTE
            and string_end(self._src, self._pos) < 0
        ):
            return BcParseError(
                f"{constants.ILLEGAL_CHARACTER}: {char}", pos=self._pos
            )
        if char != "" and char not in constants.LEGAL_CHARS:
            return BcParseError(
                f"{constants.ILLEGAL_CHARACTER}: {char}", pos=self._pos
            )
        return BcParseError(
            constants.SYNTAX_ERROR, incomplete=char == "", pos=self._pos
        )

    def _read_number(self) -> BcNumber:
        start = self._pos
        while (
            self._pos < len(self._src)
            and self._src[self._pos] in constants.NUMBER_CHARS
        ):
            self._pos += 1
        try:
            return read_base_number(
                self._src[start : self._pos], self._state.ibase
            )
        except BcParseError as exc:
            raise BcParseError(exc.text, exc.incomplete, start) from exc

    def _read_identifier(self) -> str:
        if (
            self._pos >= len(self._src)
            or self._src[self._pos] not in constants.NAME_START
        ):
            return ""
        start = self._pos
        self._pos += 1
        while (
            self._pos < len(self._src)
            and self._src[self._pos] in constants.NAME_CHARS
        ):
            self._pos += 1
        return self._src[start : self._pos]

    def _emit(self, num: BcNumber) -> str:
        """Render one value the moment the statement reaches it.

        GNU writes a value where its own instruction runs, not at the end
        of the statement, so everything an element changes before it is
        already in force and everything a later element changes is not:
        `print 255, obase=16` writes `255` and then `10`, and
        `print 5, last` writes the 5 twice.

        Args:
            num (BcNumber): the value the element evaluated to.

        Returns:
            str: the value in the output base as it stands now.
        """
        self._state.last = num
        return render_number(num, self._state.obase)

    def _read_string(self) -> str:
        self._skip_blanks()
        start = self._pos
        end = string_end(self._src, start)
        if end < 0:
            raise self.unexpected()
        self._pos = end
        return self._src[start + 1 : end - 1]

    def _read_target(self) -> str:
        self._skip_blanks()
        name = self._read_identifier()
        if name != "":
            return name
        if (
            self._pos < len(self._src)
            and self._src[self._pos] == constants.LAST_ALIAS
            and self._src[self._pos + 1 : self._pos + 2]
            not in constants.DIGIT_CHARS
        ):
            self._pos += 1
            return constants.LAST_ALIAS
        return ""

    def parse_statement(self) -> None:
        """Parse one statement, appending whatever it writes.

        An assignment writes nothing, which is why `x=5` prints where
        `(x=5)` does not; an increment is not an assignment, so `x++`
        prints 5. Only an expression statement writes a trailing newline,
        which is what leaves `print` and a bare string mid-line.
        """
        if self._is_halt():
            raise BcHalt()
        if self._peek() == constants.STRING_QUOTE:
            # A bare string is written exactly as it was typed: GNU
            # expands escapes for `print` alone, so `"a\n"` writes a
            # backslash and an `n`. It does not touch `last` either.
            self._writes.append(self._read_string())
            return
        if self._is_print():
            self._parse_print()
            return
        probe = self._try_assignment()
        if probe is None:
            self._writes.append(self._emit(self.parse_expr()))
            self._writes.append("\n")
            return
        name, op = probe
        self._assign(name, op, self.parse_expr())

    def _is_print(self) -> bool:
        # A whole identifier, so `printx` stays an ordinary variable, and
        # a keyword rather than a name, so `print=1` and `1+print` are
        # still syntax errors on the reserved word.
        mark = self._pos
        self._skip_blanks()
        if self._read_identifier() == constants.PRINT_NAME:
            return True
        self._pos = mark
        return False

    def _parse_print(self) -> None:
        # Each element is written as it is reached, so a refusal partway
        # down the list keeps what came before it. A string element is
        # unescaped where the same string alone is not, and an expression
        # element prints even when it is an assignment: `print x=5`
        # writes 5 where the statement `x=5` writes nothing.
        while True:
            if self._peek() == constants.STRING_QUOTE:
                self._writes.append(unescape(self._read_string()))
            else:
                self._writes.append(self._emit(self.parse_expr()))
            if not self._match(","):
                return

    def _is_halt(self) -> bool:
        # `halt` is a statement, never part of an expression, so it only
        # counts when it is the whole statement: `halt 1+1`, `1+halt` and
        # `x=halt` all stay syntax errors on the reserved word.
        mark = self._pos
        self._skip_blanks()
        if self._read_identifier() == constants.HALT_NAME and self.done():
            return True
        self._pos = mark
        return False

    def _try_assignment(self) -> tuple[str, str] | None:
        mark = self._pos
        name = self._read_target()
        if not assignable(name):
            self._pos = mark
            return None
        self._skip_blanks()
        rest = self._src[self._pos :]
        for op in constants.COMPOUND_OPS:
            if rest.startswith(f"{op}="):
                self._pos += 2
                return name, op
        # `x =- 2` is `=` then a negation, not the historical `-=`, so
        # the compound spellings are read before the bare `=` and never
        # across it.
        if rest.startswith("=") and not rest.startswith("=="):
            self._pos += 1
            return name, ""
        self._pos = mark
        return None

    def _assign(self, name: str, op: str, rhs: BcNumber) -> BcNumber:
        value = rhs
        if op != "":
            value = apply_binary(op, self._read_value(name), rhs, self._state)
        self._store(name, value)
        return self._read_value(name)

    def _read_value(self, name: str) -> BcNumber:
        state = self._state
        if name == constants.SCALE_NAME:
            return BcNumber(state.scale, 0)
        if name == constants.IBASE_NAME:
            return BcNumber(state.ibase, 0)
        if name == constants.OBASE_NAME:
            return BcNumber(state.obase, 0)
        if name in (constants.LAST_NAME, constants.LAST_ALIAS):
            return state.last
        return state.variables.get(name, ZERO)

    def _store(self, name: str, num: BcNumber) -> None:
        state = self._state
        requested = truncate_int(num)
        if name == constants.SCALE_NAME:
            if requested < 0:
                state.warnings.append(
                    runtime_warning_line(constants.NEGATIVE_SCALE)
                )
                requested = 0
            state.scale = clamp_scale(requested)
            return
        if name == constants.IBASE_NAME:
            state.ibase = self._clamp_base(
                requested, constants.MAX_IBASE, constants.IBASE_TOO_SMALL
            )
            return
        if name == constants.OBASE_NAME:
            state.obase = self._clamp_base(
                requested, constants.MAX_OBASE, constants.OBASE_TOO_SMALL
            )
            return
        # The stored value is already truncated, so raising `scale`
        # afterwards cannot recover digits a narrower scale dropped.
        if name in (constants.LAST_NAME, constants.LAST_ALIAS):
            state.last = num
            return
        state.variables[name] = num

    def _clamp_base(self, requested: int, ceiling: int, warning: str) -> int:
        if requested < constants.MIN_BASE:
            self._state.warnings.append(runtime_warning_line(warning))
            return constants.MIN_BASE
        return min(requested, ceiling)

    def parse_expr(self) -> BcNumber:
        """Parse an expression, assignment included.

        Assignment is part of the expression grammar, not just the
        statement one, which is why a bare `x=5` prints nothing but
        `(x=5)` prints 5.

        Returns:
            BcNumber: the value and its scale.
        """
        probe = self._try_assignment()
        if probe is None:
            return self._parse_additive()
        name, op = probe
        return self._assign(name, op, self.parse_expr())

    def _parse_additive(self) -> BcNumber:
        left = self._parse_term()
        while True:
            char = self._peek()
            if char not in ("+", "-"):
                return left
            # GNU's lexer reads `++` and `--` as one token each, so a
            # doubled sign is never an operator followed by a sign:
            # `1++2` is refused where `1+ +2` would be `1 + (+2)` if
            # there were a unary `+`, and there is not.
            if self._src.startswith(char * 2, self._pos):
                return left
            self._consume()
            left = apply_binary(char, left, self._parse_term(), self._state)

    def _parse_term(self) -> BcNumber:
        left = self._parse_unary()
        while True:
            char = self._peek()
            if char not in ("*", "/", "%"):
                return left
            self._consume()
            left = apply_binary(char, left, self._parse_unary(), self._state)

    def _parse_unary(self) -> BcNumber:
        if self._match("++"):
            return self._parse_prefix_step(1)
        if self._match("--"):
            return self._parse_prefix_step(-1)
        char = self._peek()
        if char == "-":
            self._consume()
            operand = self._parse_unary()
            return BcNumber(-operand.coefficient, operand.scale)
        # No unary `+`: GNU has no such operator, so `+5` is a syntax
        # error charged to its own line rather than an incomplete
        # construct charged to the next one.
        return self._parse_power()

    def _parse_prefix_step(self, delta: int) -> BcNumber:
        name = self._read_target()
        if not assignable(name):
            raise self.unexpected()
        old = self._read_value(name)
        self._store(
            name, apply_binary("+", old, BcNumber(delta, 0), self._state)
        )
        return self._read_value(name)

    def _parse_power(self) -> BcNumber:
        base = self._parse_atom()
        if self._peek() != "^":
            return base
        self._consume()
        return apply_binary("^", base, self._parse_unary(), self._state)

    def _parse_atom(self) -> BcNumber:
        char = self._peek()
        if char == "(":
            self._consume()
            value = self.parse_expr()
            if not self._match(")"):
                raise self.unexpected()
            return value
        if char == constants.LAST_ALIAS:
            if (
                self._src[self._pos + 1 : self._pos + 2]
                in constants.DIGIT_CHARS
            ):
                return self._read_number()
            return self._parse_name()
        if char in constants.DIGIT_CHARS:
            return self._read_number()
        if char in constants.NAME_START:
            return self._parse_name()
        raise self.unexpected()

    def _parse_name(self) -> BcNumber:
        self._skip_blanks()
        start = self._pos
        name = self._read_target()
        if name in constants.BUILTIN_CALLS:
            if self._peek() == "(":
                return self._parse_builtin_call(name)
            if name == constants.SCALE_NAME:
                return self._parse_postfix(name)
            # A builtin with no `(` is a legal prefix, so GNU charges the
            # failure to the line after it: bare `length` and bare `sqrt`
            # report the next line where `length=2` reports their own.
            raise BcParseError(
                constants.SYNTAX_ERROR,
                incomplete=self._peek() == "",
                pos=start,
            )
        if name in constants.REGISTERS:
            return self._parse_postfix(name)
        if name in constants.RESERVED_WORDS:
            raise BcParseError(constants.SYNTAX_ERROR, pos=start)
        if self._match("("):
            arg = self.parse_expr()
            if not self._match(")"):
                raise self.unexpected()
            if self._state.math_mode and name in constants.MATH_FUNCS:
                return call_function(name, arg, self._state.scale)
            # GNU compiles the call and only then finds no such function,
            # so this is the runtime shape, with a trailing period.
            raise BcRuntimeError(f"Function {name} not defined.")
        return self._parse_postfix(name)

    def _parse_builtin_call(self, name: str) -> BcNumber:
        self._consume()
        arg = self.parse_expr()
        if not self._match(")"):
            raise self.unexpected()
        return call_builtin(name, arg, self._state.scale)

    def _parse_postfix(self, name: str) -> BcNumber:
        # An undefined name reads as 0, silently; only writing to a
        # reserved word is an error.
        value = self._read_value(name)
        if self._match("++"):
            self._store(
                name, apply_binary("+", value, BcNumber(1, 0), self._state)
            )
        elif self._match("--"):
            self._store(
                name, apply_binary("-", value, BcNumber(1, 0), self._state)
            )
        return value

    def done(self) -> bool:
        """Whether the whole statement was consumed.

        Returns:
            bool: True when only blanks remain.
        """
        self._skip_blanks()
        return self._pos >= len(self._src)


def eval_statement(text: str, state: BcState, writes: list[str]) -> None:
    """Evaluate one bc statement against the run's state.

    Args:
        text (str): the statement, already split off and stripped.
        state (BcState): the run's registers and symbol table.
        writes (list[str]): where the statement's output is appended,
            already rendered. A refusal leaves behind whatever was
            written before it.

    Raises:
        BcParseError: the statement cannot be parsed.
        BcRuntimeError: a non-fatal runtime error such as a zero divisor.
    """
    parser = Parser(text, state, writes)
    parser.parse_statement()
    if not parser.done():
        raise parser.unexpected()
