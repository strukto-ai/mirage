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

from mirage.shell.constants import PARAMETER_NAME

# What bash reads a braced name against when it expands `${...}`: what
# ends a name, what ends one after a special parameter, the specials a
# `#` measures and a `!` follows, the special parameters themselves, the
# operators a `:` arms, and what may follow a name.
_NAME_ENDS = "#%^,~:-=?+/@}"
_SPECIAL_ENDS = "#%:-=?+/@}"
_LENGTH_SPECIALS = "-?#@"
_INDIRECT_SPECIALS = "#?@*"
_SPECIALS = "@*#?-$!"
_NULL_OPERATORS = "-=?+"
_OPERATORS = "}@#%-=?+/^,~"
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_DIGITS = re.compile(r"[0-9]+")


def scan_parameter(text: str, start: int) -> tuple[str, int] | None:
    """Recognize a plain dollar reference, returning its name and end.

    Names use Bash's ASCII identifier grammar. Unbraced positionals
    consume one digit; braces permit multiple digits. Special parameters
    consume one character. The caller owns quoting and must only scan a
    live dollar. Complex braced operators remain the expansion parser's
    responsibility and return None here, as do non-reference dollars.

    Args:
        text (str): shell source containing the reference.
        start (int): character offset of the live dollar.
    """
    if start < 0 or start >= len(text) or text[start] != "$":
        return None
    begin = start + 1
    braced = text[begin : begin + 1] == "{"
    if braced:
        begin += 1
    match = PARAMETER_NAME.match(text, begin)
    if match is None:
        return None
    end = match.end()
    if not braced and "0" <= text[begin] <= "9":
        end = begin + 1
    name = text[begin:end]
    if braced:
        if text[end : end + 1] != "}":
            return None
        end += 1
    return name, end


def bad_substitution(text: str) -> bool:
    """Whether bash refuses a ``${...}`` for its spelling alone.

    bash reads the braces only when the word holding them expands, and
    then reports ``bad substitution`` for a name that is no identifier,
    positional or special parameter (``${a b}``, ``${ a}``, ``${}``), an
    element reference that is not one whole (``${a[1]x}``), a ``#``
    measuring more than a name (``${#a-x}``), or a name followed by
    anything but an operator (``${a:}``, ``${a*}``). The braces are
    read as bash reads them, so ``${!a b*}``, which bash reads as a
    prefix, passes here as it does in bash.

    Args:
        text (str): the expansion, from ``${`` through its closing ``}``.
    """
    s = text[2:]
    end = _name_end(
        s, 0, "}" if s[:1] == "#" and _starts_name(s[1:2]) else _NAME_ENDS
    )
    name = s[:end]
    if not name and s[:1] == "@":
        name, end = "@", 1
    elif name[:1] == "!" and s[end : end + 2] == "@}":
        name, end = name + "@", end + 1
    if (not name and s[:1] != "" and s[0] in _LENGTH_SPECIALS) or (
        name == "!" and s[1:2] != "" and s[1] in _INDIRECT_SPECIALS
    ):
        head = s[: len(name) + 1]
        end = _name_end(s, len(head), _SPECIAL_ENDS, subscripts=False)
        name = s[:end]
    c, i = s[end : end + 1], end + 1
    substring = False
    if c == ":" and s[i : i + 1] != "" and s[i] in _NULL_OPERATORS:
        c, i = s[i], i + 1
    elif c == ":" and s[i : i + 1] != "}":
        substring = True
    elif name == "#" and s[i : i + 1] == "}" and c != "":
        if c in _LENGTH_SPECIALS:
            name, c = name + c, "}"
        elif c in "%:=+/":
            return True
    indirect = (
        name[:1] == "!"
        and name[1:2] != ""
        and (
            _starts_name(name[1])
            or name[1].isascii()
            and name[1].isdigit()
            or name[1] in _INDIRECT_SPECIALS
        )
    )
    if name[:1] == "#" and len(name) > 1:
        return c != "}" or not _length_name(name[1:])
    if (
        indirect
        and c == "}"
        and (
            name[-1] in "*@"
            and _starts_name(name[1])
            or name[-1] == "]"
            and _element(name[1:])
        )
    ):
        return False
    word = name[1:] if indirect else name
    if not (word and _length_name(word)):
        return True
    return not substring and (c == "" or c not in _OPERATORS)


def _starts_name(char: str) -> bool:
    return char != "" and (char == "_" or char.isascii() and char.isalpha())


def _name_end(
    text: str, start: int, ends: str, subscripts: bool = True
) -> int:
    """Where a name read from ``start`` stops: at one of ``ends``, past a
    backslash's character and, reading a variable name, past a whole
    ``[...]``."""
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if subscripts and char == "[":
            close = _subscript_end(text, index)
            if close is not None:
                index = close + 1
                continue
        elif char in ends:
            return index
        index += 1
    return len(text)


def _subscript_end(text: str, start: int) -> int | None:
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if char in "'\"":
            close = text.find(char, index + 1)
            if close < 0:
                return None
            index = close
        elif char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _element(name: str) -> bool:
    """Whether ``name`` is one whole element reference, ``a[...]`` with a
    subscript that is not empty."""
    bracket = name.find("[")
    if bracket < 1 or _IDENTIFIER.fullmatch(name, 0, bracket) is None:
        return False
    close = _subscript_end(name, bracket)
    return close == len(name) - 1 and close > bracket + 1


def _length_name(name: str) -> bool:
    """Whether ``${#name}`` measures something."""
    return (
        name == ""
        or len(name) == 1
        and name in _SPECIALS
        or _DIGITS.fullmatch(name) is not None
        or _element(name)
        or _IDENTIFIER.fullmatch(name) is not None
    )
