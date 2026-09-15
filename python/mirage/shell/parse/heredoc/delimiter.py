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

from mirage.shell.escapes import decode_ansi_c
from mirage.shell.parse.heredoc.constants import DQUOTE_ESCAPABLE
from mirage.shell.parse.heredoc.line import (construct_closer, construct_end,
                                             quote_end)


def ansi_c_end(token: str, start: int) -> int:
    """Index of the apostrophe closing a ``$'`` section.

    A backslash escapes the next character inside the section, the
    closing quote included, so ``$'\\''`` names one apostrophe. This is
    quote_end's rule for the same section, read over a word's characters
    rather than the source's bytes.

    Args:
        token (str): the word being read.
        start (int): index of the section's first character.

    Returns:
        int: the closing quote's index, or the word's length when the
        section never closes.
    """
    index = start
    while index < len(token):
        if token[index] == "\\" and index + 1 < len(token):
            index += 2
            continue
        if token[index] == "'":
            return index
        index += 1
    return len(token)


def literal_construct_end(token: str, start: int) -> int | None:
    """Skip a substitution-shaped delimiter fragment without quote removal.

    Args:
        token (str): delimiter word.
        start (int): character offset of a possible expansion opener.
    """
    if token[start] not in ("$", "`"):
        return None
    data = token.encode()
    offset = len(token[:start].encode())
    closer = construct_closer(data, offset,
                              False) if token[start] == "$" else None
    if closer is not None:
        end = construct_end(data, offset, closer)
    elif token[start] == "`":
        end = quote_end(data, offset)
    else:
        return None
    return None if end is None else len(data[:end].decode())


def clean_delimiter(token: str) -> str:
    """The delimiter word as bash reads it: quotes removed, escapes resolved.

    ``'EOF'``, ``"EOF"``, ``EN'D'`` and ``\\EOF`` all end their body at a
    line reading ``END`` or ``EOF``; the quoting only decides whether the
    body expands. Quote removal follows the shell's own rules: a
    backslash escapes anything outside quotes, nothing inside single
    quotes, and only ``$``, `````, ``"`` and itself inside double quotes,
    so ``"E\\$F"`` names ``E$F`` while ``"E\\xF"`` keeps its backslash.
    A ``$`` that is neither quoted nor escaped opens a dollar-quoted
    section instead of naming itself, wherever in the word it sits:
    ``$'A\\tB'`` names the word its ANSI-C escapes build, and ``$"A"``
    names its double-quoted content, which is what a locale carrying no
    translation for it gives back. Every other ``$`` is literal, since a
    delimiter is never expanded. A backslash before a newline is the
    reader's line continuation and takes the newline with it, outside
    quotes and inside double quotes alike, so ``EO\\<newline>F`` names
    ``EOF``; single quotes keep both characters, leaving a newline in
    the delimiter that no single line can equal.

    Args:
        token (str): the heredoc_start token as typed.
    """
    out: list[str] = []
    quote: str | None = None
    index = 0
    while index < len(token):
        char = token[index]
        end = literal_construct_end(token, index) if quote is None else None
        if end is not None:
            out.append(token[index:end])
            index = end
            continue
        if quote == "'":
            if char == "'":
                quote = None
            else:
                out.append(char)
        elif quote == '"':
            if char == '"':
                quote = None
            elif char == "\\" and token[index + 1:index + 2] == "\n":
                index += 1
            elif (char == "\\" and index + 1 < len(token)
                  and token[index + 1] in DQUOTE_ESCAPABLE):
                index += 1
                out.append(token[index])
            else:
                out.append(char)
        elif char == "$" and token[index + 1:index + 2] == "'":
            end = ansi_c_end(token, index + 2)
            out.append(decode_ansi_c(token[index + 2:end]))
            index = end
        elif char == "$" and token[index + 1:index + 2] == '"':
            quote = '"'
            index += 1
        elif char in ("'", '"'):
            quote = char
        elif char == "\\" and token[index + 1:index + 2] == "\n":
            index += 1
        elif char == "\\" and index + 1 < len(token):
            index += 1
            out.append(token[index])
        else:
            out.append(char)
        index += 1
    return "".join(out)


def delimiter_quoted(token: str) -> bool:
    """Whether the delimiter word is quoted, so its body reads literally.

    Quoting anywhere in the word, even partial (``EN'D'``, ``\\EOF``),
    turns expansion off for the whole body. A backslash before a newline
    is not quoting: it is the reader's line continuation, gone before the
    word is read, so ``EO\\<newline>F`` expands its body exactly as
    ``EOF`` does, while ``EO\\<newline>F\\G`` does not, its second
    backslash quoting a character.

    Args:
        token (str): the heredoc_start token as typed.

    Returns:
        bool: True when the body takes no expansion.
    """
    index = 0
    while index < len(token):
        char = token[index]
        end = literal_construct_end(token, index)
        if end is not None:
            index = end
            continue
        if char == "\\" and token[index + 1:index + 2] == "\n":
            index += 1
        elif char in ("\\", "'", '"'):
            return True
        index += 1
    return False
