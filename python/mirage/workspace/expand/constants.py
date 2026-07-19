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

from mirage.shell.types import NodeType as NT

# Sentinels delimiting an inert atom in a brace-expansion template: an
# already-expanded chunk that never contributes brace metacharacters,
# matching bash's ordering where brace expansion runs before parameter
# and command substitution. Shell input cannot contain NUL, so the
# sentinel bytes cannot collide with template text.
INERT_OPEN = "\x00"
INERT_CLOSE = "\x01"

# GNU sequence-expression grammar for `{x..y[..step]}`: numeric
# endpoints (optionally signed), or single alphabetic characters.
NUM_SEQ = re.compile(r"^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$")
CHAR_SEQ = re.compile(r"^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$")

# Unquoted expansions whose result splits into words on whitespace.
SPLIT_TYPES = frozenset({
    NT.SIMPLE_EXPANSION,
    NT.EXPANSION,
})

# Node types that may carry a brace-expandable word.
BRACE_WORD_TYPES = frozenset({
    NT.CONCATENATION,
    NT.BRACE_EXPRESSION,
})

# Children of a brace word whose raw text joins the template as
# literal, brace-eligible text; everything else expands first and
# joins as an inert atom.
BRACE_LITERAL_TYPES = frozenset({
    NT.WORD,
    NT.NUMBER,
    NT.BRACE_EXPRESSION,
})

# Arithmetic operator tokens from tree-sitter that pass through as-is
# when the expression text is reconstructed for the shared evaluator
# (mirage.shell.arith).
ARITH_OPERATORS = frozenset({
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "==",
    "!=",
    "<",
    ">",
    "<=",
    ">=",
    "<<",
    ">>",
    "&",
    "|",
    "^",
    "~",
    "&&",
    "||",
    "!",
    "?",
    ":",
    "(",
    ")",
    ",",
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "<<=",
    ">>=",
    "&=",
    "^=",
    "|=",
    "++",
    "--",
})

# Arithmetic delimiter tokens that mark the start/end of $((...)) and
# the (( ... )) arithmetic command.
ARITH_DELIMITERS = frozenset({"$((", "((", "))"})
