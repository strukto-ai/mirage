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

NAME_CONT = frozenset(
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_")

DIGITS = frozenset(b"0123456789")

BASH_KEYWORDS = frozenset({
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
})

STRUCTURAL_TOKENS = frozenset({
    "(",
    ")",
    "{",
    "}",
    "[",
    "]",
    '"',
    "'",
    "`",
})

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
