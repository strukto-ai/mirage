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

# Byte values the scanners compare against; tree-sitter reports byte
# offsets, so the source is read as bytes throughout.
BACKSLASH = 0x5C
NEWLINE = 0x0A
HASH = 0x23
DOLLAR = 0x24
LESS = 0x3C
GREATER = 0x3E
OPEN_PAREN = 0x28
CLOSE_PAREN = 0x29
CLOSE_BRACE = 0x7D
OPEN_BRACKET = 0x5B
CLOSE_BRACKET = 0x5D
SINGLE_QUOTE = 0x27
DOUBLE_QUOTE = 0x22
BACKTICK = 0x60

QUOTE_OPENERS = frozenset((SINGLE_QUOTE, DOUBLE_QUOTE, BACKTICK))

# `$(`, `<(` and `>(` open a substitution that runs to its balancing paren.
SUBSTITUTION_OPENERS = frozenset((DOLLAR, LESS, GREATER))

# A `#` opens a comment only where a word may start: after a blank or a
# metacharacter, never inside a word (`a#b`, `$#`).
COMMENT_PRECEDERS = frozenset(b" \t\n;|&()<>")

# What a command may follow, so where `case` and `esac` are reserved
# words rather than ordinary ones (`grep case f` names a file).
COMMAND_PRECEDERS = frozenset(b"\n;|&()")

# What still opens a quote inside an expanding one: a backtick takes
# both quotes and a double quote takes a backtick, while a `'` inside
# double quotes is an ordinary byte (`"it's"` is one word).
NESTED_QUOTES = {
    DOUBLE_QUOTE: frozenset((BACKTICK, )),
    BACKTICK: frozenset((SINGLE_QUOTE, DOUBLE_QUOTE)),
}

CASE = b"case"
ESAC = b"esac"

# Bytes the heredoc scanner skips at the start of the body's first line.
LINE_BLANKS = frozenset(b" \t\r")

# Bytes a body may open with that never reach the scanner as body text.
SKIPPED_BLANKS = LINE_BLANKS | {NEWLINE}

# What a backslash escapes in an unquoted body (`\$`, `` \` ``, `\\`).
ESCAPE_PARTNERS = frozenset(b"$`\\")

# What a backslash escapes inside a double-quoted word; before any other
# character it stays literal, so `"E\xF"` names E\xF.
DQUOTE_ESCAPABLE = frozenset('$`"\\')

# The letter written over a masked byte, and the one used instead when
# the delimiter itself starts with it.
FILLER = ord("x")
ALTERNATE_FILLER = ord("y")

HEREDOC_START = "heredoc_start"
HEREDOC_BODY = "heredoc_body"
DASH_ARROW = "<<-"
SEMICOLON = 0x3B

# Bash's metacharacters other than blanks: what ends an unquoted word, so
# where tree-sitter's delimiter token has run past the delimiter (`EOF;`
# is the word `EOF` and then a `;`).
WORD_BREAKERS = frozenset("|&;()<>")

# The statement terminators an operator line keeps as bash reads them at
# the start of a line, longest first so `;;&` is not read as `;;` and an
# `&`. A lone `;` is not among them: bash refuses a line opening with one,
# so the newline that precedes the moved body stands in for it.
KEPT_TERMINATORS = (b";;&", b";;", b";&", b")")
