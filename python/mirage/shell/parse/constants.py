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

# Statement separators. One that lands inside an ERROR node has nothing
# to separate (a line starting with `;`, `| s`, `a ; ; b`, `a &; b`).
SEPARATOR_TOKENS = frozenset({";", "&", "|", "&&", "||"})

# The case-item terminators: a list ends at one only inside a case item.
CASE_TERMINATORS = frozenset({";;", ";&", ";;&"})

# The characters that end an unquoted word.
WORD_BREAKS = frozenset(" \t\n;&|()<>")

# Every operator bash reads, longest first, so the first one a line
# starts with is its token.
OPERATORS = (
    ";;&",
    "&>>",
    "<<<",
    "<<-",
    ";;",
    ";&",
    "&&",
    "||",
    "|&",
    "&>",
    "<<",
    ">>",
    "<&",
    ">&",
    "<>",
    ">|",
    ";",
    "&",
    "|",
    "<",
    ">",
    "(",
    ")",
)

# The characters operators are spelled with (the `-` of `<<-`).
OPERATOR_CHARS = frozenset(";&|<>()-")

REDIRECTIONS = frozenset(
    {"<", ">", ">>", "<&", ">&", "<>", ">|", "&>", "&>>", "<<<", "<<", "<<-"}
)

# The reserved words that close or continue a compound command. Spelled
# by an alias, one is a command where a command starts, except inside
# that alias's own text, where its name stays reserved.
CLOSING_WORDS = frozenset(
    {"then", "else", "elif", "fi", "do", "done", "esac", "}", "in", "]]"}
)

# Every reserved word. bash takes one as such only where a command starts
# (and after a compound command), never after a command's own words.
RESERVED_WORDS = CLOSING_WORDS | {
    "if",
    "case",
    "for",
    "select",
    "while",
    "until",
    "function",
    "time",
    "{",
    "!",
    "[[",
    "coproc",
}

# The reserved words opening a compound command: what a function body or
# a named coproc must start with.
COMPOUND_OPENERS = frozenset(
    {"{", "if", "while", "until", "for", "select", "case", "[["}
)

# The builtins whose arguments read `name=(` as an array, as an
# assignment before a command does.
ARRAY_BUILTINS = frozenset(
    {
        "alias",
        "declare",
        "eval",
        "export",
        "let",
        "local",
        "readonly",
        "typeset",
    }
)

# The `[[ ]]` operators taking one operand, and those taking two (with
# `<` and `>`, which are operator tokens).
UNARY_TESTS = frozenset(
    "-a -b -c -d -e -f -g -h -k -p -r -s -t -u -w -x -G -L -N -O -S -z -n "
    "-o -v -R".split()
)
BINARY_TESTS = frozenset(
    "== = != =~ -eq -ne -lt -le -gt -ge -nt -ot -ef".split()
)

# The characters a shell name is spelled with; it cannot start with a
# digit.
NAME_START = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_")
NAME_CHARS = NAME_START | frozenset("0123456789")

# The characters that open an extended pattern before `(`, which the
# right side of `==`, `=` and `!=` in `[[ ]]` reads with extglob on.
EXTGLOB_OPENERS = frozenset("@!+*?")

# bash's `syntax error near `X'` without "unexpected token" quotes the
# line back from where its reader stopped: to a blank, or to one of these,
# which it keeps.
NEAR_TEXT_STOPS = frozenset(";&|")

# How deep the syntax reader nests compound commands, substitutions and
# `[[ ]]` groups before it refuses a line at the next opener, as bash
# refuses a line nested past its own reader (thousands deep there).
MAX_NESTING = 64

# How the syntax reader takes the next token: whether `name=(` opens an
# array, `name[` reads a subscript up to its `]` across blanks, `((`
# opens arithmetic (and, where a command starts, is read again as two
# subshells when it does not close on its line), a leading `[` opens an
# array element's subscript, digits before `<` or `>` stay a word inside
# `[[ ]]`, an array in a function body reads reserved words as such, and
# the first array after a redirection reads an element's `name[` as a
# subscript.
READ_ARRAYS = 1
READ_SUBSCRIPTS = 2
READ_ARITH = 4
READ_START = 8
READ_ELEMENT = 16
READ_TEST = 32
READ_BODY = 64
READ_KEYS = 128
READ_PREFIX = READ_ARRAYS | READ_SUBSCRIPTS
READ_FOLLOW = READ_PREFIX | READ_ARITH
READ_COMMAND = READ_FOLLOW | READ_START

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
