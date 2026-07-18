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
from typing import Any, TypeAlias

import tree_sitter

FunctionBody: TypeAlias = list[tree_sitter.Node]


class NodeType(StrEnum):
    """Tree-sitter-bash node types."""
    COMMAND = "command"
    PIPELINE = "pipeline"
    LIST = "list"
    REDIRECTED_STATEMENT = "redirected_statement"
    SUBSHELL = "subshell"
    IF_STATEMENT = "if_statement"
    FOR_STATEMENT = "for_statement"
    WHILE_STATEMENT = "while_statement"
    CASE_STATEMENT = "case_statement"
    CASE_ITEM = "case_item"
    FUNCTION_DEFINITION = "function_definition"
    DECLARATION_COMMAND = "declaration_command"
    UNSET_COMMAND = "unset_command"
    TEST_COMMAND = "test_command"
    COMPOUND_STATEMENT = "compound_statement"
    NEGATED_COMMAND = "negated_command"
    VARIABLE_ASSIGNMENT = "variable_assignment"
    FOR = "for"
    SELECT = "select"
    WHILE = "while"
    UNTIL = "until"
    EXPORT = "export"
    LOCAL = "local"
    WORD = "word"
    NUMBER = "number"
    COMMAND_NAME = "command_name"
    VARIABLE_NAME = "variable_name"
    SIMPLE_EXPANSION = "simple_expansion"
    EXPANSION = "expansion"
    COMMAND_SUBSTITUTION = "command_substitution"
    ARITHMETIC_EXPANSION = "arithmetic_expansion"
    CONCATENATION = "concatenation"
    STRING = "string"
    STRING_CONTENT = "string_content"
    RAW_STRING = "raw_string"
    PROCESS_SUBSTITUTION = "process_substitution"
    EXTGLOB_PATTERN = "extglob_pattern"
    DO_GROUP = "do_group"
    ELIF_CLAUSE = "elif_clause"
    ELSE_CLAUSE = "else_clause"
    FILE_REDIRECT = "file_redirect"
    HEREDOC_REDIRECT = "heredoc_redirect"
    HEREDOC_BODY = "heredoc_body"
    HEREDOC_START = "heredoc_start"
    HEREDOC_END = "heredoc_end"
    HERESTRING_REDIRECT = "herestring_redirect"
    FILE_DESCRIPTOR = "file_descriptor"
    ARRAY = "array"
    AND = "&&"
    OR = "||"
    SEMI = ";"
    BACKGROUND = "&"
    PIPE = "|"
    PIPE_STDERR = "|&"
    REDIRECT_OUT = ">"
    REDIRECT_APPEND = ">>"
    REDIRECT_IN = "<"
    REDIRECT_STDERR = ">&"
    REDIRECT_BOTH = "&>"
    REDIRECT_BOTH_APPEND = "&>>"
    HEREDOC_START_TOKEN = "<<"
    HERESTRING_TOKEN = "<<<"
    OPEN_PAREN = "("
    CLOSE_PAREN = ")"
    OPEN_BRACE = "{"
    CLOSE_BRACE = "}"
    OPEN_BRACKET = "["
    CLOSE_BRACKET = "]"
    DOUBLE_OPEN_PAREN = "(("
    DOUBLE_CLOSE_PAREN = "))"
    DOUBLE_SEMICOLON = ";;"
    DQUOTE = '"'
    IF = "if"
    THEN = "then"
    ELIF = "elif"
    ELSE = "else"
    FI = "fi"
    IN = "in"
    DO = "do"
    DONE = "done"
    CASE = "case"
    ESAC = "esac"
    FUNCTION = "function"
    PROGRAM = "program"
    BINARY_EXPRESSION = "binary_expression"
    UNARY_EXPRESSION = "unary_expression"
    NEGATION_EXPRESSION = "negation_expression"
    PARENTHESIZED_EXPRESSION = "parenthesized_expression"
    TERNARY_EXPRESSION = "ternary_expression"
    POSTFIX_EXPRESSION = "postfix_expression"
    ARITH_OPEN = "(("
    TEST_OPERATOR = "test_operator"
    SPECIAL_VARIABLE_NAME = "special_variable_name"
    COMMENT = "comment"
    ERROR = "ERROR"


ERREXIT_EXEMPT_TYPES = frozenset({
    NodeType.LIST,
    NodeType.NEGATED_COMMAND,
})

SET_FLAG_TO_OPTION = {
    "e": "errexit",
    "u": "nounset",
    "x": "xtrace",
    "f": "noglob",
}


class RedirectKind(StrEnum):
    STDOUT = "stdout"
    STDERR = "stderr"
    STDIN = "stdin"
    STDERR_TO_STDOUT = "stderr_to_stdout"
    HEREDOC = "heredoc"
    HERESTRING = "herestring"


@dataclass
class Redirect:
    """Parsed redirect from a redirected_statement."""
    fd: int
    target: Any
    target_node: Any = None
    kind: RedirectKind = RedirectKind.STDOUT
    append: bool = False
    pipeline: Any = None
    expand_vars: bool = True


class ShellBuiltin(StrEnum):
    """Shell builtin command names.

    Commands that don't touch the filesystem.
    Handled directly by the executor, not dispatched
    to mounts.
    """
    # session state
    PWD = "pwd"
    CD = "cd"
    EXPORT = "export"
    UNSET = "unset"
    LOCAL = "local"
    SET = "set"
    PRINTENV = "printenv"
    WHOAMI = "whoami"
    MAN = "man"
    HISTORY = "history"
    # control
    TRUE = "true"
    FALSE = "false"
    SOURCE = "source"
    DOT = "."
    EVAL = "eval"
    READ = "read"
    SHIFT = "shift"
    TRAP = "trap"
    TEST = "test"
    BRACKET = "["
    DOUBLE_BRACKET = "[["
    # job control
    WAIT = "wait"
    FG = "fg"
    KILL = "kill"
    JOBS = "jobs"
    PS = "ps"
    # output / text processing (no filesystem)
    ECHO = "echo"
    PRINTF = "printf"
    SLEEP = "sleep"
    # nested shells
    BASH = "bash"
    SH = "sh"
    # python exec
    PYTHON = "python"
    PYTHON3 = "python3"
    # javascript exec
    NODE = "node"
    JS = "js"
    # commands handled by executor
    XARGS = "xargs"
    TIMEOUT = "timeout"
    BREAK = "break"
    CONTINUE = "continue"
    RETURN = "return"
    EXIT = "exit"
