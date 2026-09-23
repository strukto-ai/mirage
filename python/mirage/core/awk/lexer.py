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

from dataclasses import dataclass
from enum import StrEnum

from mirage.core.awk.errors import AwkSyntaxError


class TokKind(StrEnum):
    NUMBER = "NUMBER"
    STRING = "STRING"
    ERE = "ERE"
    NAME = "NAME"
    FUNC_NAME = "FUNC_NAME"
    BUILTIN = "BUILTIN"
    KEYWORD = "KEYWORD"
    NEWLINE = "NEWLINE"
    EOF = "EOF"
    OP = "OP"


KEYWORDS = frozenset({
    "BEGIN", "END", "function", "func", "break", "continue", "delete", "do",
    "else", "exit", "for", "getline", "if", "in", "next", "nextfile", "print",
    "printf", "return", "while"
})

BUILTIN_FUNCS = frozenset({
    "atan2", "close", "cos", "exp", "fflush", "gsub", "index", "int", "length",
    "log", "match", "rand", "sin", "split", "sprintf", "sqrt", "srand", "sub",
    "substr", "system", "tolower", "toupper"
})

THREE_CHAR_OPS = ("**=", )

TWO_CHAR_OPS = ("+=", "-=", "*=", "/=", "%=", "^=", "==", "!=", "<=", ">=",
                "&&", "||", "!~", "++", "--", ">>", "**")

ONE_CHAR_OPS = "{}()[],;+-*/%^!><|?:~$="

STRING_ESCAPES = {
    "\\": "\\",
    "/": "/",
    '"': '"',
    "a": "\a",
    "b": "\b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
}

OCTAL_DIGITS = "01234567"

DIGITS = "0123456789"

WORD_START = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_"

WORD_CHARS = WORD_START + DIGITS

ENDS_EXPRESSION_OPS = frozenset({")", "]", "$", "++", "--"})


@dataclass(frozen=True, slots=True)
class Token:
    kind: TokKind
    text: str
    value: str = ""


class Lexer:

    def __init__(self, src: str) -> None:
        self.src = src
        self.pos = 0
        self.tokens: list[Token] = []

    def error(self, message: str) -> AwkSyntaxError:
        """Build a syntax error naming the offending offset.

        Args:
            message (str): human readable reason.
        """
        return AwkSyntaxError(f"awk: syntax error: {message}")

    def prev_ends_expression(self) -> bool:
        """Report whether the last token could terminate an expression.

        POSIX resolves ``/`` as division when it follows something that
        can end an expression and as the start of an ERE otherwise.
        """
        if not self.tokens:
            return False
        last = self.tokens[-1]
        if last.kind in (TokKind.NUMBER, TokKind.STRING, TokKind.NAME,
                         TokKind.ERE):
            return True
        if last.kind is TokKind.BUILTIN:
            return True
        if last.kind is TokKind.OP:
            return last.text in ENDS_EXPRESSION_OPS
        return False

    def read_string(self) -> Token:
        self.pos += 1
        out: list[str] = []
        while self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch == '"':
                self.pos += 1
                return Token(TokKind.STRING, "".join(out), "".join(out))
            if ch == "\n":
                raise self.error("newline in string")
            if ch != "\\":
                out.append(ch)
                self.pos += 1
                continue
            self.pos += 1
            if self.pos >= len(self.src):
                raise self.error("unterminated string")
            esc = self.src[self.pos]
            if esc in OCTAL_DIGITS:
                digits = ""
                while (len(digits) < 3 and self.pos < len(self.src)
                       and self.src[self.pos] in OCTAL_DIGITS):
                    digits += self.src[self.pos]
                    self.pos += 1
                out.append(chr(int(digits, 8)))
                continue
            out.append(STRING_ESCAPES.get(esc, "\\" + esc))
            self.pos += 1
        raise self.error("unterminated string")

    def read_ere(self) -> Token:
        self.pos += 1
        out: list[str] = []
        while self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch == "/":
                self.pos += 1
                return Token(TokKind.ERE, "".join(out), "".join(out))
            if ch == "\n":
                raise self.error("newline in regex")
            if ch == "\\" and self.pos + 1 < len(self.src):
                nxt = self.src[self.pos + 1]
                # Only `\/` collapses here; every other escape belongs to
                # the ERE layer, which needs the backslash intact.
                out.append("/" if nxt == "/" else "\\" + nxt)
                self.pos += 2
                continue
            out.append(ch)
            self.pos += 1
        raise self.error("unterminated regex")

    def read_number(self) -> Token:
        start = self.pos
        seen_dot = False
        while self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch in DIGITS:
                self.pos += 1
                continue
            if ch == "." and not seen_dot:
                seen_dot = True
                self.pos += 1
                continue
            break
        if self.pos < len(self.src) and self.src[self.pos] in "eE":
            save = self.pos
            self.pos += 1
            if self.pos < len(self.src) and self.src[self.pos] in "+-":
                self.pos += 1
            if self.pos < len(self.src) and self.src[self.pos] in DIGITS:
                while self.pos < len(
                        self.src) and self.src[self.pos] in DIGITS:
                    self.pos += 1
            else:
                self.pos = save
        text = self.src[start:self.pos]
        return Token(TokKind.NUMBER, text, text)

    def read_word(self) -> Token:
        start = self.pos
        while self.pos < len(self.src) and self.src[self.pos] in WORD_CHARS:
            self.pos += 1
        word = self.src[start:self.pos]
        if word in KEYWORDS:
            return Token(TokKind.KEYWORD, word, word)
        if word in BUILTIN_FUNCS:
            return Token(TokKind.BUILTIN, word, word)
        # A NAME glued directly to `(` is a call; a space makes it
        # concatenation with a parenthesised expression instead.
        if self.pos < len(self.src) and self.src[self.pos] == "(":
            return Token(TokKind.FUNC_NAME, word, word)
        return Token(TokKind.NAME, word, word)

    def read_operator(self) -> Token:
        for op in THREE_CHAR_OPS:
            if self.src.startswith(op, self.pos):
                self.pos += len(op)
                return Token(TokKind.OP, "^=")
        for op in TWO_CHAR_OPS:
            if self.src.startswith(op, self.pos):
                self.pos += len(op)
                return Token(TokKind.OP, "^" if op == "**" else op)
        ch = self.src[self.pos]
        if ch not in ONE_CHAR_OPS:
            raise self.error(f"unexpected character '{ch}'")
        self.pos += 1
        return Token(TokKind.OP, ch)

    def run(self) -> list[Token]:
        """Tokenize the whole program source.

        Returns:
            list[Token]: tokens ending in a single EOF token.
        """
        while self.pos < len(self.src):
            ch = self.src[self.pos]
            if ch == "\\" and self.src.startswith("\\\n", self.pos):
                self.pos += 2
                continue
            if ch in " \t\r":
                self.pos += 1
                continue
            if ch == "#":
                while self.pos < len(self.src) and self.src[self.pos] != "\n":
                    self.pos += 1
                continue
            if ch == "\n":
                self.pos += 1
                self.tokens.append(Token(TokKind.NEWLINE, "\n"))
                continue
            if ch == '"':
                self.tokens.append(self.read_string())
                continue
            if ch == "/" and not self.prev_ends_expression():
                self.tokens.append(self.read_ere())
                continue
            if ch in DIGITS or (ch == "." and self.pos + 1 < len(self.src)
                                and self.src[self.pos + 1] in DIGITS):
                self.tokens.append(self.read_number())
                continue
            if ch in WORD_START:
                self.tokens.append(self.read_word())
                continue
            self.tokens.append(self.read_operator())
        self.tokens.append(Token(TokKind.EOF, ""))
        return self.tokens


def tokenize(src: str) -> list[Token]:
    """Split awk program source into tokens.

    Args:
        src (str): the awk program text.

    Returns:
        list[Token]: tokens ending in a single EOF token.
    """
    return Lexer(src).run()


__all__ = [
    "BUILTIN_FUNCS",
    "KEYWORDS",
    "Lexer",
    "TokKind",
    "Token",
    "tokenize",
]
