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

ARITH_OPEN_TOKEN = "(("

QUOTES = (b"'", b'"')

# Nodes whose backslashes escape nothing, so a backslash-newline in one
# is text rather than a line continuation.
VERBATIM_TYPES = frozenset({"raw_string", "ansi_c_string", "comment"})

BASH_KEYWORDS = frozenset(
    {
        "if",
        "then",
        "else",
        "elif",
        "fi",
        "for",
        "while",
        "until",
        "do",
        "done",
        "case",
        "esac",
        "in",
        "function",
        "select",
    }
)

# Tokens that make an ERROR node a real syntax error: brackets, quotes,
# and an expansion or substitution opener left unclosed, for which bash
# reads to the end of input looking for the match and runs none of the
# line.
STRUCTURAL_TOKENS = frozenset(
    {
        "(",
        ")",
        "{",
        "}",
        "[",
        "]",
        '"',
        "'",
        "`",
        "$(",
        "$((",
        "${",
        "$[",
        "<(",
        ">(",
    }
)

# Each expansion or substitution opener: the token that closes it and the
# character bash's end-of-input diagnostic names for it.
OPENER_CLOSERS: dict[str, tuple[str, str]] = {
    "$(": (")", ")"),
    "$((": ("))", ")"),
    "<(": (")", ")"),
    ">(": (")", ")"),
    "${": ("}", "}"),
    "$[": ("]", "]"),
}

CLOSING_TOKENS = frozenset({")", "))", "}", "]"})

# The quotes an input can end inside; bash reads on looking for the match.
QUOTE_TOKENS = frozenset({"'", '"', "`"})

# The compound commands an ERROR can leave open, by the token closing
# each. Input ending inside one is bash's `syntax error: unexpected end
# of file`, not an unexpected token. An unclosed subshell parses with its
# `)` missing instead, and a `(` an ERROR holds is unexpected (`echo x (`).
COMPOUND_CLOSERS: dict[str, str] = {
    "{": "}",
    "if": "fi",
    "case": "esac",
    "while": "done",
    "until": "done",
    "for": "done",
    "select": "done",
}

# A construct the grammar leaves with a missing closer, by the character
# bash names when the input ends inside it. A subshell is absent: bash
# reports an unexpected end of file there instead.
CONSTRUCT_CLOSERS: dict[str, str] = {
    "command_substitution": ")",
    "process_substitution": ")",
    "arithmetic_expansion": ")",
    "expansion": "}",
    "array": ")",
}

# Statement separators. One that lands inside an ERROR node has nothing
# to separate (a line starting with `;`, `| s`, `a ; ; b`, `a &; b`), and
# bash refuses every such line with `syntax error near unexpected token`.
SEPARATOR_TOKENS = frozenset({";", "&", "|", "&&", "||"})

# The case-item terminators. The grammar also accepts them as plain
# statement separators, so `true;;s` parses without an ERROR node; bash
# only accepts them inside a case item.
CASE_TERMINATORS = frozenset({";;", ";&", ";;&"})

# Where a `variable_name` node is a write target rather than a read:
# the assignment's name and the for loop's variable. Everything else --
# expansions, arithmetic, subscripts -- reads the name.
TARGET_NAME_FIELDS = {
    "variable_assignment": "name",
    "for_statement": "variable",
}

# Nodes whose bare `variable_name` children declare or delete a name
# (`readonly R`, `export Z`, `unset X`); their assignment children still
# carry reads and are walked.
DECLARING_NODES = frozenset({"declaration_command", "unset_command"})

# The declaring builtins whose bare invocation prints the environment
# (`export`, `export -p`, `declare`); `local` prints only a function's
# locals and `readonly` only the read-only set, neither of which a
# managed entry can be.
DECL_PRINTER_HEADS = frozenset({"export", "declare", "typeset"})

# The declaring builtins whose `-n` makes the operand a nameref.
# `export -n` and `unset -n` mean other things and are not these.
NAMEREF_HEADS = frozenset({"declare", "typeset", "local"})

# Names a builtin reads with no ``$NAME`` in the text: ``read`` splits
# its input on ``$IFS``; ``getopts`` resumes from ``$OPTIND`` and
# consults ``$OPTERR`` before printing a diagnostic. ``cd``'s names
# depend on the operand shape (``cd_reads``).
IMPLICIT_HEAD_READS: dict[str, frozenset[str]] = {
    "read": frozenset({"IFS"}),
    "getopts": frozenset({"OPTIND", "OPTERR"}),
}

# A relative ``cd`` operand searches ``$CDPATH`` unless it is anchored
# (``/``, ``./``, ``../``) or a tilde the expansion anchors first;
# mirrors ``_cdpath_searchable`` in the cd builtin.
CD_ANCHORS = ("/", "./", "../", "~")

# The ``[[`` comparators whose operands evaluate as arithmetic, so a
# bare word resolves as a variable and recurses through its value.
# ``test``/``[`` are absent on purpose: the flat builtin parses its
# integer operands strictly (``to_int``), bash's own split.
ARITH_TEST_OPERATORS = frozenset({"-eq", "-ne", "-lt", "-le", "-gt", "-ge"})
