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

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, TypeAlias

import tree_sitter

FunctionBody: TypeAlias = list[tree_sitter.Node]


@dataclass(frozen=True, slots=True)
class ElementOps:
    """Array-element callbacks the arithmetic evaluator resolves through.

    The evaluator owns no session, so a caller that wants ``a[i]`` and
    ``m[key]`` to mean anything injects these two facts. The split is
    what keeps subscript semantics out of the evaluator: whether the
    subscript text is an arithmetic expression (indexed) or a literal
    key (associative) is the variable's to answer, and only the session
    knows the variable.

    Args:
        resolve (Callable[[str, str, Mapping[str, str]], str]): canonical
            key for one reference: the evaluated index for an indexed
            name, the literal (quote-stripped) text for an associative
            one. The mapping is the evaluator's current view, pending
            assignments included, so ``i=2, a[i]`` reads the new ``i``.
        read (Callable[[str, str], str | None]): the element's stored
            text, None when the element is unset.
        is_assoc (Callable[[str], bool] | None): whether a name holds an
            associative array, whose subscript is a key. Given, the
            evaluator evaluates an indexed subscript itself, in its own
            record, and hands ``resolve`` the index; absent, ``resolve``
            evaluates the subscript text (a caller outside a session).
    """
    resolve: Callable[[str, str, Mapping[str, str]], str]
    read: Callable[[str, str], str | None]
    is_assoc: Callable[[str], bool] | None = None


@dataclass(frozen=True, slots=True)
class ArithWrite:
    """One assignment an arithmetic evaluation produced.

    Args:
        name (str): the variable's name.
        key (str | None): the canonical subscript ``ElementOps.resolve``
            gave, or None for a bare name (which lands as element 0 of
            an array, or the scalar itself).
        value (str): the stored decimal text.
    """
    name: str
    key: str | None
    value: str


@dataclass(frozen=True, slots=True)
class ArithResult:
    """What one arithmetic evaluation produced.

    Args:
        value (int): the expression's value.
        writes (tuple[ArithWrite, ...]): the assignments made, one per
            target, in the order of each target's last write, for the
            caller to land through the session door. Bare and
            subscripted targets share the one sequence, because a bare
            name aliases element 0 and ``((a[0]=1, a=2))`` has to
            leave 2.
    """
    value: int
    writes: tuple[ArithWrite, ...] = ()


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
    VARIABLE_ASSIGNMENTS = "variable_assignments"
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
    BRACE_EXPRESSION = "brace_expression"
    STRING = "string"
    STRING_CONTENT = "string_content"
    RAW_STRING = "raw_string"
    ANSI_C_STRING = "ansi_c_string"
    TRANSLATED_STRING = "translated_string"
    PROCESS_SUBSTITUTION = "process_substitution"
    EXTGLOB_PATTERN = "extglob_pattern"
    REGEX = "regex"
    DO_GROUP = "do_group"
    ELIF_CLAUSE = "elif_clause"
    ELSE_CLAUSE = "else_clause"
    FILE_REDIRECT = "file_redirect"
    HEREDOC_REDIRECT = "heredoc_redirect"
    HEREDOC_BODY = "heredoc_body"
    HEREDOC_START = "heredoc_start"
    HEREDOC_END = "heredoc_end"
    HEREDOC_CONTENT = "heredoc_content"
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
    REDIRECT_CLOBBER = ">|"
    REDIRECT_APPEND = ">>"
    REDIRECT_IN = "<"
    REDIRECT_STDERR = ">&"
    REDIRECT_DUP_IN = "<&"
    REDIRECT_CLOSE_OUT = ">&-"
    REDIRECT_CLOSE_IN = "<&-"
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
    ARITH_CLOSE = "))"
    C_STYLE_FOR_STATEMENT = "c_style_for_statement"
    TEST_OPERATOR = "test_operator"
    SPECIAL_VARIABLE_NAME = "special_variable_name"
    COMMENT = "comment"
    ERROR = "ERROR"


@dataclass(frozen=True, slots=True)
class OptionWord:
    """One word of the shell's option grammar.

    Args:
        settings (tuple[tuple[str, bool], ...]): shell options the word
            turns on or off, in the order they were written.
        other (str): cluster letters that name no shell option. `set`
            ignores them; shell startup reads its own startup letters
            out of them and refuses the rest.
        consumed (int): words the option took, 2 for the `-o NAME` form.
    """
    settings: tuple[tuple[str, bool], ...] = ()
    other: str = ""
    consumed: int = 1


class RedirectKind(StrEnum):
    STDOUT = "stdout"
    STDERR = "stderr"
    STDIN = "stdin"
    STDERR_TO_STDOUT = "stderr_to_stdout"
    HEREDOC = "heredoc"
    HERESTRING = "herestring"
    # `N>&word` with a word that is neither a number nor `-` on a
    # descriptor other than 1: bash refuses it as `word: ambiguous
    # redirect` before the command runs, so the target is kept for the
    # message and nothing is opened.
    AMBIGUOUS = "ambiguous"


@dataclass
class Redirect:
    """Parsed redirect from a redirected_statement.

    Args:
        fd (int): the descriptor the redirect claims, -1 for `&>`.
        target (Any): the target path, or the dup'd fd number.
        target_node (Any): the tree-sitter node the target came from.
        kind (RedirectKind): which stream the redirect moves.
        append (bool): whether the write appends rather than truncates.
        clobber (bool): whether the operator was `>|`, which overrides
            `set -C` for this one redirect and nothing else.
        pipeline (Any): the process substitution feeding the target.
        expand_vars (bool): whether the target undergoes expansion.
    """
    fd: int
    target: Any
    target_node: Any = None
    kind: RedirectKind = RedirectKind.STDOUT
    append: bool = False
    clobber: bool = False
    pipeline: Any = None
    expand_vars: bool = True


class ProcessSubDirection(StrEnum):
    """Which way a process substitution carries bytes.

    `<(cmd)` is INPUT (the inner command's stdout feeds our stdin),
    `>(cmd)` is OUTPUT (our stdout feeds the inner command's stdin).
    """
    INPUT = "input"
    OUTPUT = "output"


class ShellBuiltin(StrEnum):
    """Shell builtin command names.

    Commands that don't touch the filesystem.
    Handled directly by the executor, not dispatched
    to mounts. Listed by tier and group (``BUILTIN_GROUP``
    below is the source of truth).
    """
    # grammar: the shell's own language
    # -- working directory
    PWD = "pwd"
    CD = "cd"
    # -- variables and positional parameters
    EXPORT = "export"
    UNSET = "unset"
    LOCAL = "local"
    # declare / typeset / readonly are parser-owned (the declaration
    # node runs them, they never reach the executor's table); rows here
    # so `type` reports them and the tiers file them as grammar.
    DECLARE = "declare"
    TYPESET = "typeset"
    READONLY = "readonly"
    SET = "set"
    READ = "read"
    MAPFILE = "mapfile"
    READARRAY = "readarray"
    SHIFT = "shift"
    GETOPTS = "getopts"
    LET = "let"
    # -- shell state
    TRAP = "trap"
    SHOPT = "shopt"
    UMASK = "umask"
    ALIAS = "alias"
    UNALIAS = "unalias"
    EXEC = "exec"
    # -- conditions
    TEST = "test"
    BRACKET = "["
    DOUBLE_BRACKET = "[["
    # -- output
    ECHO = "echo"
    PRINTF = "printf"
    # -- running lines
    SOURCE = "source"
    DOT = "."
    EVAL = "eval"
    COMMAND = "command"
    # -- name lookup
    TYPE = "type"
    WHICH = "which"
    # -- status and control flow
    TRUE = "true"
    FALSE = "false"
    COLON = ":"
    BREAK = "break"
    CONTINUE = "continue"
    RETURN = "return"
    EXIT = "exit"
    # tools: programs the line invokes
    # -- environment and identity
    PRINTENV = "printenv"
    ENV = "env"
    WHOAMI = "whoami"
    # -- manuals and history
    MAN = "man"
    HISTORY = "history"
    # -- job control
    WAIT = "wait"
    FG = "fg"
    KILL = "kill"
    JOBS = "jobs"
    DISOWN = "disown"
    PS = "ps"
    # -- clock
    SLEEP = "sleep"
    # -- nested shells
    BASH = "bash"
    SH = "sh"
    # -- interpreters
    PYTHON = "python"
    PYTHON3 = "python3"
    NODE = "node"
    JS = "js"
    # -- command runners
    XARGS = "xargs"
    TIMEOUT = "timeout"


class BuiltinTier(StrEnum):
    """Which of two things a shell builtin is, as taxonomy.

    ``GRAMMAR`` is the shell's own language: it moves session state,
    control flow, or the line's own streams, and never reaches a backend
    except through the op dispatcher. ``TOOL`` is a program the line
    invokes that a real system ships as a separate binary, or that
    reaches beyond the session (an interpreter, the job table, the
    history recording). The permission layer reads no tier: every
    builtin is a subject of a command allowlist exactly like an
    installed command, and both tiers are deniable by name.
    """
    GRAMMAR = "grammar"
    TOOL = "tool"


class BuiltinGroup(StrEnum):
    """The family a shell builtin belongs to, one level below the tier.

    Every group sits in exactly one tier (``GROUP_TIER``), so filing a
    word in a group also files its tier; ``BUILTIN_GROUP`` is the one
    row per word. A listing (bare ``man``) or a rule can name a group
    where it would otherwise have to spell out the words.
    """
    # grammar
    WORKING_DIRECTORY = "working-directory"
    VARIABLES = "variables"
    SHELL_STATE = "shell-state"
    CONDITIONS = "conditions"
    OUTPUT = "output"
    RUNNING_LINES = "running-lines"
    NAME_LOOKUP = "name-lookup"
    CONTROL_FLOW = "control-flow"
    # tools
    ENVIRONMENT = "environment"
    MANUALS_AND_HISTORY = "manuals-and-history"
    JOB_CONTROL = "job-control"
    CLOCK = "clock"
    NESTED_SHELLS = "nested-shells"
    INTERPRETERS = "interpreters"
    COMMAND_RUNNERS = "command-runners"


@dataclass(frozen=True, slots=True)
class BacktickSegment:
    """One piece of a backtick region as the evaluator lexes it: a
    command a pair encloses, or the literal text between two pairs.

    Args:
        text (str): the segment's text, a command's with its escapes
            resolved, as the nested line parses it.
        command (bool): whether a pair encloses it.
        start (int): where the segment's raw text starts in the region.
        end (int): the index after its last raw character; for a
            command, the closing backtick's.
    """

    text: str
    command: bool
    start: int
    end: int
