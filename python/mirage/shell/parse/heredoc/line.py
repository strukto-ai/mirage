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

from mirage.shell.parse.heredoc import constants


def construct_closer(data: bytes, index: int, bare: bool) -> int | None:
    """The byte closing the construct that opens at ``index``.

    ``${`` runs to its balancing brace, ``$[`` to its bracket, and
    ``$(``, ``<(`` and ``>(`` to their balancing paren. A lone ``(``
    opens one only inside another
    paren construct, where it is a subshell or a parenthesized case
    pattern; anywhere else it is ordinary text, as ``cat <<EOF (`` is.

    Args:
        data (bytes): the shell source.
        index (int): byte offset to read at.
        bare (bool): whether a lone ``(`` opens a construct here.

    Returns:
        int | None: the closing byte, or None when nothing opens here.
    """
    byte = data[index]
    following = data[index + 1:index + 2]
    if byte == constants.DOLLAR and following == b"{":
        return constants.CLOSE_BRACE
    if byte == constants.DOLLAR and following == b"[":
        return constants.CLOSE_BRACKET
    if byte in constants.SUBSTITUTION_OPENERS and following == b"(":
        return constants.CLOSE_PAREN
    if bare and byte == constants.OPEN_PAREN:
        return constants.CLOSE_PAREN
    return None


def reserved_word(data: bytes, index: int, word: bytes) -> bool:
    """Whether ``word`` stands alone at ``index`` where a command starts.

    ``case`` and ``esac`` are reserved only there and only whole, so
    ``grep case f`` names a file, ``case=1`` assigns a variable and
    ``esacs`` is a word.

    Args:
        data (bytes): the shell source.
        index (int): byte offset to read at.
        word (bytes): the reserved word to look for.

    Returns:
        bool: True when the word is reserved here.
    """
    if data[index:index + len(word)] != word:
        return False
    after = data[index + len(word):index + len(word) + 1]
    if after and after[0] not in constants.COMMENT_PRECEDERS:
        return False
    position = index - 1
    while position >= 0 and data[position] in constants.LINE_BLANKS:
        position -= 1
    return position >= 0 and data[position] in constants.COMMAND_PRECEDERS


def quote_end(data: bytes, start: int) -> int | None:
    """Offset just past the quote closing the one at ``start``.

    A backslash escapes the next byte inside double quotes, backticks
    and ``$'...'``, never inside a plain single-quoted string. Double
    quotes and backticks also expand, so a substitution inside one runs
    to its own close whatever it holds, and the quotes it holds are its
    own: ``"$( : "a<newline>b"; echo /out)"`` closes at the quote after
    the paren, not at the one before ``a``. A backtick nests inside a
    double quote and both quotes nest inside a backtick, while a ``'``
    inside double quotes is an ordinary byte (``"it's"``).

    Args:
        data (bytes): the shell source.
        start (int): byte offset of the opening quote.

    Returns:
        int | None: the offset, or None when the quote never closes.
    """
    quote = data[start]
    expands = quote != constants.SINGLE_QUOTE
    escapes = expands or data[start - 1:start] == b"$"
    nested = constants.NESTED_QUOTES.get(quote, frozenset())
    index = start + 1
    while index < len(data):
        byte = data[index]
        closer = (construct_closer(data, index, False)
                  if expands and byte == constants.DOLLAR else None)
        if byte == constants.BACKSLASH and escapes:
            index += 2
        elif byte == quote:
            return index + 1
        elif byte in nested:
            end = quote_end(data, index)
            if end is None:
                return None
            index = end
        elif closer is not None:
            end = construct_end(data, index, closer)
            if end is None:
                return None
            index = end
        else:
            index += 1
    return None


def construct_end(data: bytes, start: int, closer: int) -> int | None:
    """Offset just past the byte closing the construct at ``start``.

    What the construct holds is read the way the operator line itself
    is: a backslash escapes the next byte, quotes hide their contents,
    and a nested construct runs to its own close, all across newlines,
    since no body is read until the word holding them is whole. Inside
    ``$( )`` a ``#`` after a blank or a metacharacter opens a comment,
    because a command may start there; inside ``${ }`` it is part of the
    word (``${x:- #y}`` expands to `` #y``). A ``)`` that ends a case
    pattern closes no construct, so an open ``case`` is counted and the
    paren passed over while one is: ``$(case x in<newline>x)`` runs to
    its ``esac``, and a parenthesized pattern balances itself. Brackets
    inside ``$[...]`` balance too, including array subscripts.

    Args:
        data (bytes): the shell source.
        start (int): byte offset where the construct opens.
        closer (int): the byte that closes it.

    Returns:
        int | None: the offset, or None when the construct never closes.
    """
    paren = closer == constants.CLOSE_PAREN
    index = start + (1 if data[start] in (constants.OPEN_PAREN,
                                          constants.OPEN_BRACKET) else 2)
    cases = 0
    while index < len(data):
        byte = data[index]
        nested = (constants.CLOSE_BRACKET if closer == constants.CLOSE_BRACKET
                  and byte == constants.OPEN_BRACKET else construct_closer(
                      data, index, paren))
        if byte == constants.BACKSLASH:
            index += 2
        elif byte in constants.QUOTE_OPENERS:
            end = quote_end(data, index)
            if end is None:
                return None
            index = end
        elif nested is not None:
            end = construct_end(data, index, nested)
            if end is None:
                return None
            index = end
        elif byte == closer and not cases:
            return index + 1
        elif paren and reserved_word(data, index, constants.CASE):
            cases += 1
            index += len(constants.CASE)
        elif cases and reserved_word(data, index, constants.ESAC):
            cases -= 1
            index += len(constants.ESAC)
        elif (paren and byte == constants.HASH
              and data[index - 1] in constants.COMMENT_PRECEDERS):
            newline = data.find(b"\n", index)
            if newline < 0:
                return None
            index = newline + 1
        else:
            index += 1
    return None


def operator_line_end(data: bytes, start: int) -> int | None:
    """Offset of the newline ending the logical line the operator sits on.

    Read forward from the end of the delimiter word the way bash's
    reader does: a backslash escapes the next byte, so ``\\<newline>``
    continues the line; quotes and backticks hide their contents; ``$(``,
    ``<(`` and ``>(`` run to their balancing paren and ``${`` to its
    balancing brace, both across newlines, since no body is read until
    the word holding them is whole; a ``#`` opening a word, which is one
    after a blank or a metacharacter (``cat <<EOF;# don't``), starts a
    comment that ends at the newline. A trailing ``|`` or ``&&`` does not
    extend the line: bash gathers the body at the first newline and reads
    the rest of the pipeline after the terminator.

    Args:
        data (bytes): the shell source.
        start (int): byte offset just past the heredoc_start token.

    Returns:
        int | None: offset of the newline, or None when the line never
        ends.
    """
    index = start
    while index < len(data):
        byte = data[index]
        closer = construct_closer(data, index, False)
        if byte == constants.BACKSLASH:
            index += 2
        elif byte in constants.QUOTE_OPENERS:
            end = quote_end(data, index)
            if end is None:
                return None
            index = end
        elif closer is not None:
            end = construct_end(data, index, closer)
            if end is None:
                return None
            index = end
        elif (byte == constants.HASH and index > 0
              and data[index - 1] in constants.COMMENT_PRECEDERS):
            newline = data.find(b"\n", index)
            return None if newline < 0 else newline
        elif byte == constants.NEWLINE:
            return index
        else:
            index += 1
    return None
