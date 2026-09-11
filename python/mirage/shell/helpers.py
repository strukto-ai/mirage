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

import shlex

import tree_sitter

from mirage.shell.constants import (FD_BOTH, FD_CLOSE, FD_STDERR, FD_STDIN,
                                    FD_STDOUT)
from mirage.shell.escapes import (decode_ansi_c, unescape_dquoted,
                                  unescape_unquoted)
from mirage.shell.types import FunctionBody
from mirage.shell.types import NodeType as NT
from mirage.shell.types import ProcessSubDirection, Redirect, RedirectKind
from mirage.utils.path import expand_tilde


def get_text(node: tree_sitter.Node) -> str:
    """Get the text content of a node."""
    return (node.text or b"").decode()


def byte_offset(text: str, index: int) -> int:
    """Where an index into a node's text falls in the parser's offsets.

    tree-sitter places a node by the bytes of the UTF-8 source, so an
    index counted in code points reads one place too early for every
    multibyte character before it.

    Args:
        text (str): the text the index is into.
        index (int): a code-point index into it.
    """
    return len(text[:index].encode())


def get_command_name(node: tree_sitter.Node) -> str:
    """Get the command name string."""
    for c in node.named_children:
        if c.type == NT.COMMAND_NAME:
            return (c.text or b"").decode()
    return ""


def claimed_descriptor(command: tree_sitter.Node,
                       last: tree_sitter.Node) -> int | None:
    """The descriptor a bare ``0`` before a redirect operator names.

    tree-sitter-bash reads ``0>&-`` and ``0<f`` as an operand ``0``
    followed by an undecorated redirect, where it gives every other
    digit string its ``file_descriptor`` node. bash's rule is that a
    digit string touching the operator is the descriptor, so the number
    is one when it ends exactly where a sibling ``file_redirect``
    begins; ``cat a 0 >&-`` keeps its operand.

    Args:
        command (tree_sitter.Node): the command node the number is in.
        last (tree_sitter.Node): the command's last child.
    """
    if last.type != NT.NUMBER or command.parent is None:
        return None
    for sibling in command.parent.named_children:
        if (sibling.type == NT.FILE_REDIRECT
                and sibling.start_byte == last.end_byte):
            return int(get_text(last))
    return None


def get_parts(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """Get command parts as child nodes.

    Preserves expansion nodes for later processing. A bare ``$`` word
    is an anonymous token rather than a named child, but bash passes it
    through as a literal argument (``echo $`` prints ``$``), so it is
    the one anonymous child that stays - unless a string starts at its
    very next byte, where it is the translation marker of ``$"..."``
    and the string node carries the whole word.
    """
    _SKIP = frozenset({NT.FILE_REDIRECT, NT.HERESTRING_REDIRECT})
    children = node.children
    parts: list[tree_sitter.Node] = []
    for position, c in enumerate(children):
        if c.is_named and c.type not in _SKIP:
            if position == len(children) - 1 and claimed_descriptor(
                    node, c) is not None:
                continue
            parts.append(c)
        elif c.type == "$":
            nxt = children[position +
                           1] if position + 1 < len(children) else None
            if (nxt is None or nxt.type != NT.STRING
                    or nxt.start_byte != c.end_byte):
                parts.append(c)
    return parts


def brace_expands(text: str) -> bool:
    """Whether unquoted text holds a brace expansion (``{a,b}``,
    ``{1..3}``), which the shell turns into several words.

    Args:
        text (str): the word as typed.
    """
    start = -1
    for position, char in enumerate(text):
        if char == "{":
            start = position
        elif char == "}" and start >= 0:
            body = text[start + 1:position]
            if "," in body or ".." in body:
                return True
            start = -1
    return False


def literal_word(node: tree_sitter.Node,
                 home: str | None = None) -> str | None:
    """The text a word names before any expansion, or None.

    A word is literal when nothing in it waits on the shell: a plain
    word, a number, a quoted string with no expansion inside, or a
    concatenation of those. Quotes are removed, escapes resolved and a
    leading unquoted ``~`` expanded the way expansion would. A word
    carrying a parameter, command, arithmetic or process substitution,
    or a brace expression, answers None: what it names is known only
    when it runs.

    Args:
        node (tree_sitter.Node): a command word node, or the
            command_name wrapping one.
        home (str | None): the home directory a leading ``~`` names;
            None leaves it literal, as bash does with no ``$HOME``.
    """
    ntype = node.type
    if ntype == NT.COMMAND_NAME:
        named = node.named_children
        return literal_word(named[0], home) if named else get_text(node)
    if ntype in (NT.WORD, NT.NUMBER, NT.CONCATENATION) and brace_expands(
            get_text(node)):
        return None
    if ntype in (NT.WORD, NT.NUMBER):
        return expand_tilde(unescape_unquoted(get_text(node)), home)
    if ntype == NT.RAW_STRING:
        return get_text(node)[1:-1]
    if ntype == NT.ANSI_C_STRING:
        return decode_ansi_c(get_text(node)[2:-1])
    if ntype == NT.TRANSLATED_STRING:
        for child in node.named_children:
            if child.type == NT.STRING:
                return literal_word(child)
        return ""
    if ntype == NT.STRING:
        pieces: list[str] = []
        for child in node.children:
            if child.type == NT.DQUOTE:
                continue
            if child.type != NT.STRING_CONTENT:
                return None
            pieces.append(unescape_dquoted(get_text(child)))
        return "".join(pieces)
    if ntype == NT.CONCATENATION:
        pieces = []
        children = node.children
        for position, child in enumerate(children):
            # The `$` of a `$"..."` is the translation marker, not text.
            if (child.type == "$" and position + 1 < len(children)
                    and children[position + 1].type == NT.STRING):
                continue
            # Only a leading unquoted piece carries a tilde prefix.
            piece = literal_word(child, home if not pieces else None)
            if piece is None:
                return None
            pieces.append(piece)
        return "".join(pieces)
    if ntype == "$":
        return "$"
    return None


def has_command_substitution(node: tree_sitter.Node) -> bool:
    """Whether the node contains a command or process substitution.

    The provision planner suppresses substitution execution, so any
    word carrying one expands to empty during a plan walk and the
    affected estimate must degrade to UNKNOWN instead of trusting the
    incomplete expansion.
    """
    if node.type in (NT.COMMAND_SUBSTITUTION, NT.PROCESS_SUBSTITUTION):
        return True
    return any(has_command_substitution(c) for c in node.named_children)


def split_env_prefix(
    parts: list[tree_sitter.Node],
) -> tuple[list[tree_sitter.Node], list[tree_sitter.Node]]:
    """Split FOO=1 BAR=2 cmd parts into (assignments, remaining).

    The single structural rule for env-prefixed commands, shared by the
    executor (which expands and applies the assignments) and the
    provision planner (which only needs the command parts).
    """
    assignments: list[tree_sitter.Node] = []
    remaining: list[tree_sitter.Node] = []
    saw_command_name = False
    for p in parts:
        if not saw_command_name and p.type == NT.VARIABLE_ASSIGNMENT:
            assignments.append(p)
            continue
        if p.type == NT.COMMAND_NAME:
            saw_command_name = True
        remaining.append(p)
    return assignments, remaining


def get_pipeline_commands(
    node: tree_sitter.Node,
) -> tuple[list[tree_sitter.Node], list[bool]]:  # noqa: E125,E501
    """Get (commands, stderr_flags) from pipeline.

    Uses node.children for pipe token detection.
    """
    commands: list[tree_sitter.Node] = []
    stderr_flags: list[bool] = []
    for c in node.children:
        if c.is_named:
            commands.append(c)
        elif c.type in (NT.PIPE, NT.PIPE_STDERR):
            stderr_flags.append(c.type == NT.PIPE_STDERR)
    return commands, stderr_flags


def get_while_parts(
    node: tree_sitter.Node,
) -> tuple[tree_sitter.Node, list[tree_sitter.Node]]:
    """Get (condition, body_commands) from while/until.

    Returns the do_group's children list so multi-statement
    bodies are preserved.
    """
    nc = node.named_children
    condition = nc[0]
    body = list(nc[1].named_children)
    return condition, body


def get_for_parts(
    node: tree_sitter.Node,
) -> tuple[str, list[tree_sitter.Node], list[tree_sitter.Node]]:
    """Get (variable, values, body_commands) from for/select.

    Returns the do_group's children list so multi-statement
    bodies are preserved.
    """
    nc = node.named_children
    variable = get_text(nc[0])
    values = [c for c in nc[1:] if c.type not in (NT.DO_GROUP, "ERROR")]
    body = list(nc[-1].named_children)
    return variable, values, body


def get_cfor_parts(
    node: tree_sitter.Node,
) -> tuple[list[list[tree_sitter.Node]], list[tree_sitter.Node]]:
    """Get ([init, cond, update], body_commands) from a C-style for.

    The expression slots are positional between the (( )) delimiters,
    separated by `;` tokens, and any of them may be empty (an empty
    list): `for ((;;))`. A slot holds every comma-separated expression
    the parser found in it, in order, since bash evaluates
    `for ((a=1, i=0; ...))` as one comma expression; keeping only the
    last child dropped `a=1`.

    Args:
        node (tree_sitter.Node): the c_style_for_statement node.
    """
    exprs: list[list[tree_sitter.Node]] = [[], [], []]
    slot = 0
    inside = False
    body: list[tree_sitter.Node] = []
    for child in node.children:
        if child.type == NT.ARITH_OPEN:
            inside = True
            continue
        if child.type == NT.ARITH_CLOSE:
            inside = False
            continue
        if inside:
            if child.type == NT.SEMI:
                slot += 1
            elif child.is_named and slot < 3:
                exprs[slot].append(child)
            continue
        if child.type == NT.DO_GROUP:
            body = list(child.named_children)
    return exprs, body


def get_subshell_body(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """Get body commands from subshell."""
    return list(node.named_children)


REDIRECT_NODE_TYPES = frozenset({
    NT.FILE_REDIRECT,
    NT.HEREDOC_REDIRECT,
    NT.HERESTRING_REDIRECT,
})

# RAW_STRING (single quotes) belongs here alongside STRING (double
# quotes): quoting a redirect target is purely syntactic in bash, so
# `> 'f'`, `> "f"` and `> f` name the same file. Omitting it left
# target_node None and target "", which silently redirected every
# single-quoted target to one phantom empty path instead of the file.
_TARGET_TYPES = frozenset({
    NT.WORD,
    NT.CONCATENATION,
    NT.SIMPLE_EXPANSION,
    NT.EXPANSION,
    NT.COMMAND_SUBSTITUTION,
    NT.STRING,
    NT.RAW_STRING,
    NT.ANSI_C_STRING,
    NT.TRANSLATED_STRING,
    NT.PROCESS_SUBSTITUTION,
})

_INPUT_OPERATORS = frozenset(
    {NT.REDIRECT_IN, NT.REDIRECT_DUP_IN, NT.REDIRECT_CLOSE_IN})
_CLOSE_OPERATORS = frozenset({NT.REDIRECT_CLOSE_OUT, NT.REDIRECT_CLOSE_IN})
_DUP_OPERATORS = frozenset({NT.REDIRECT_STDERR, NT.REDIRECT_DUP_IN})
_BOTH_OPERATORS = frozenset({NT.REDIRECT_BOTH, NT.REDIRECT_BOTH_APPEND})
_REDIRECT_OPERATORS = (
    _INPUT_OPERATORS | _CLOSE_OPERATORS | _DUP_OPERATORS
    | _BOTH_OPERATORS
    | frozenset({NT.REDIRECT_OUT, NT.REDIRECT_CLOBBER, NT.REDIRECT_APPEND}))


def _parse_file_redirect(child: tree_sitter.Node,
                         fd: int | None = None) -> Redirect:
    """Parse a single file_redirect node into a Redirect.

    The operator token decides the shape and the explicit descriptor,
    when there is one, is kept as typed: `3<f` claims fd 3 and `<&3`
    duplicates from it, and both are refused downstream rather than
    read as stdin (`shell/descriptors.py`). ``fd`` is the descriptor
    the grammar left as the command's last operand (`claimed_descriptor`),
    which a ``file_descriptor`` child overrides. Three forms carry an int
    target: a dup (`2>&1`, `>&2`, `<&0`) names the descriptor it copies,
    a close (`>&-`, `<&-`) carries FD_CLOSE, and `&>` claims FD_BOTH.
    `2>&1` alone keeps the STDERR_TO_STDOUT kind the fd router keys on;
    every other output redirect is STDOUT or STDERR by the descriptor
    it claims.
    """
    target: str | int = ""
    target_node = None
    op: str | None = None
    dup_fd: int | None = None

    for c in child.children:
        if c.type == NT.FILE_DESCRIPTOR:
            fd = int(get_text(c))
        elif c.type in _REDIRECT_OPERATORS:
            op = c.type
        elif c.type == NT.NUMBER:
            dup_fd = int(get_text(c))

    for c in child.named_children:
        if c.type in _TARGET_TYPES:
            target = get_text(c)
            target_node = c
            break

    # `>&word` with a word rather than a number is bash's other spelling
    # of `&>word`, bare or on descriptor 1 (`1>&word` sends both streams
    # too, pinned on bash 5.2). On any other explicit descriptor bash
    # refuses it as `word: ambiguous redirect`, before the command runs
    # and before any file opens, so the parse keeps the word for the
    # message rather than turning `3>&foo` into a both-streams file.
    word_dup = (op == NT.REDIRECT_STDERR and dup_fd is None
                and target_node is not None)
    if word_dup and fd is not None and fd != FD_STDOUT:
        return Redirect(fd=fd,
                        target=target,
                        target_node=target_node,
                        kind=RedirectKind.AMBIGUOUS)
    if op in _BOTH_OPERATORS or word_dup:
        return Redirect(fd=FD_BOTH,
                        target=target,
                        target_node=target_node,
                        kind=RedirectKind.STDOUT,
                        append=op == NT.REDIRECT_BOTH_APPEND)

    if fd is None:
        fd = FD_STDIN if op in _INPUT_OPERATORS else FD_STDOUT
    if op in _CLOSE_OPERATORS:
        target = FD_CLOSE
    elif op in _DUP_OPERATORS and dup_fd is not None:
        target = dup_fd

    if op in _INPUT_OPERATORS:
        kind = RedirectKind.STDIN
    elif fd == FD_STDERR and target == FD_STDOUT and op == NT.REDIRECT_STDERR:
        kind = RedirectKind.STDERR_TO_STDOUT
    elif fd == FD_STDERR:
        kind = RedirectKind.STDERR
    else:
        kind = RedirectKind.STDOUT

    return Redirect(fd=fd,
                    target=target,
                    target_node=target_node,
                    kind=kind,
                    append=op == NT.REDIRECT_APPEND,
                    clobber=op == NT.REDIRECT_CLOBBER)


def _parse_herestring_redirect(child: tree_sitter.Node) -> Redirect:
    content = ""
    target_node = None
    for candidate in child.named_children:
        if candidate.type in _TARGET_TYPES:
            content = get_text(candidate)
            target_node = candidate
            break
    return Redirect(fd=0,
                    target=content,
                    target_node=target_node,
                    kind=RedirectKind.HERESTRING)


def get_redirects(
        node: tree_sitter.Node,  # noqa: E125
) -> tuple[tree_sitter.Node | None, list[Redirect]]:
    """Parse all redirects from a redirected_statement.

    Returns (command, redirects); command is None for a bare redirect
    like `> file` (bash runs the empty command and applies redirects,
    creating/truncating the file).
    """
    nc = node.named_children
    command = nc[0] if nc and nc[0].type not in REDIRECT_NODE_TYPES else None
    redirects: list[Redirect] = []

    claimed: int | None = None
    if command is not None and command.type == NT.COMMAND:
        for child in command.named_children:
            if child.type == NT.HERESTRING_REDIRECT:
                redirects.append(_parse_herestring_redirect(child))
        if command.children:
            claimed = claimed_descriptor(command, command.children[-1])

    recover_herestring = False
    command_end = -1 if command is None else command.end_byte
    for child in nc if command is None else nc[1:]:
        if child.type == "ERROR" and get_text(child) == "<<":
            recover_herestring = True
            continue
        if child.type == NT.HEREDOC_REDIRECT:
            body, _, quoted = get_heredoc_meta(child)
            pipe_node = None
            for hc in child.named_children:
                if hc.type in (NT.PIPELINE, NT.COMMAND):
                    pipe_node = hc
                    break
            redirects.append(
                Redirect(fd=0,
                         target=body,
                         target_node=child,
                         kind=RedirectKind.HEREDOC,
                         pipeline=pipe_node,
                         expand_vars=not quoted))
            # A file redirect written before the heredoc body starts
            # (`cat <<END > out.txt`) parses INSIDE the
            # heredoc_redirect node; hoist it to a sibling.
            for hc in child.named_children:
                if hc.type == NT.FILE_REDIRECT:
                    redirects.append(_parse_file_redirect(hc))
            continue

        if child.type == NT.HERESTRING_REDIRECT:
            redirects.append(_parse_herestring_redirect(child))
            recover_herestring = False
            continue

        if child.type != NT.FILE_REDIRECT:
            recover_herestring = False
            continue

        if recover_herestring:
            redirects.append(_parse_herestring_redirect(child))
        else:
            # Only the redirect touching the operand can own it.
            fd = claimed if child.start_byte == command_end else None
            redirects.append(_parse_file_redirect(child, fd))
        recover_herestring = False

    return command, redirects


def get_list_parts(
    node: tree_sitter.Node,
) -> tuple[tree_sitter.Node, str, tree_sitter.Node]:
    """Get (left, op, right) from list node."""
    left = node.named_children[0]
    right = node.named_children[1]
    op = None
    for c in node.children:
        if c.type in (NT.AND, NT.OR, NT.SEMI):
            op = c.type
            break
    assert op is not None
    return left, op, right


def get_if_branches(
    node: tree_sitter.Node,
) -> tuple[list[tuple[tree_sitter.Node, list[tree_sitter.Node]]],
           list[tree_sitter.Node] | None]:
    """Get (branches, else_body) from if_statement.

    Each branch is (condition, body_commands) where
    body_commands is a list of tree-sitter nodes.
    else_body is also a list of nodes, or None.
    """
    nc = node.named_children
    condition: tree_sitter.Node | None = nc[0]
    body: list[tree_sitter.Node] = []
    branches: list[tuple[tree_sitter.Node, list[tree_sitter.Node]]] = []
    else_body = None

    for c in nc[1:]:
        if c.type == NT.ELIF_CLAUSE:
            if condition is not None:
                branches.append((condition, body))
            ec = c.named_children
            condition = ec[0]
            body = list(ec[1:])
        elif c.type == NT.ELSE_CLAUSE:
            if condition is not None:
                branches.append((condition, body))
                condition = None
            else_body = list(c.named_children)
        else:
            body.append(c)

    if condition is not None:
        branches.append((condition, body))

    return branches, else_body


def get_case_word(node: tree_sitter.Node) -> tree_sitter.Node:
    """Get the word being matched in case."""
    return node.named_children[0]


def get_case_items(
    node: tree_sitter.Node,
) -> list[tuple[list[tree_sitter.Node], list[tree_sitter.Node],
                str]]:  # noqa: E125,E501
    """Get (pattern_nodes, body_statements, terminator) triples from case.

    Patterns are every named child before the arm's ``)``, kept as
    nodes so quoting survives to the matcher: 'a'), "$x") and $'a\\n')
    all mean literal text where a bare word keeps its globs live. An
    arm's body is every statement up to its terminator, so
    multi-statement arms (x) cmd1; cmd2;;) keep all commands. The
    terminator is one of ``;;`` (default/last arm), ``;&`` (fall through
    into the next arm's body unconditionally), or ``;;&`` (keep testing
    the remaining patterns).
    """
    items: list[tuple[list[tree_sitter.Node], list[tree_sitter.Node],
                      str]] = []
    for c in node.named_children:
        if c.type == NT.CASE_ITEM:
            patterns: list[tree_sitter.Node] = []
            body: list[tree_sitter.Node] = []
            terminator = ";;"
            in_body = False
            for child in c.children:
                if child.type in (";;", ";&", ";;&"):
                    terminator = child.type
                elif child.type == ")":
                    in_body = True
                elif not child.is_named:
                    continue
                elif in_body:
                    body.append(child)
                else:
                    patterns.append(child)
            items.append((patterns, body, terminator))
    return items


def get_declaration_keyword(node: tree_sitter.Node) -> str:
    """Get keyword (export/local/declare) from declaration."""
    return node.children[0].type


def get_unset_args(node: tree_sitter.Node) -> list[str]:
    """Get every operand word of unset_command, keeping ``-f``/``-v``/``-n``.

    The leading option words are preserved so the handler can tell a
    function unset (``unset -f``) from a variable unset, and the operand
    span is split the way the shell does so a subscript target
    (``unset arr[1]``, quoted or not) stays one word.
    """
    operands = node.children[1:]
    if not operands:
        return []
    start = operands[0].start_byte - node.start_byte
    text = (node.text or b"")[start:].decode()
    try:
        return shlex.split(text)
    except ValueError:
        return [get_text(c) for c in node.named_children]


def get_negated_command(node: tree_sitter.Node) -> tree_sitter.Node:
    """Get inner command from negated_command (! cmd)."""
    return node.named_children[0]


def get_heredoc_parts(redirect_node: tree_sitter.Node) -> tuple[str, str]:
    """Get (delimiter, body) from heredoc_redirect."""
    delimiter = ""
    body = ""
    for c in redirect_node.named_children:
        if c.type == NT.HEREDOC_START:
            delimiter = get_text(c)
        elif c.type == NT.HEREDOC_BODY:
            body = get_text(c)
    return delimiter, body


def get_heredoc_meta(
        redirect_node: tree_sitter.Node) -> tuple[str, bool, bool]:
    """Get (body, dash, quoted) from heredoc_redirect.

    - dash: True if operator was `<<-` (strip leading tabs from body lines)
    - quoted: True if delimiter was wrapped in quotes (no var expansion)
    """
    delimiter, body = get_heredoc_parts(redirect_node)
    # Any quoting anywhere in the delimiter (even partial, `EN'D'`)
    # disables expansion, matching bash.
    quoted = "'" in delimiter or '"' in delimiter or "\\" in delimiter
    dash = False
    for c in redirect_node.children:
        if c.type == "<<-":
            dash = True
            break
    if dash and body:
        body = "\n".join(line.lstrip("\t") for line in body.split("\n"))
    body = normalize_heredoc_body(body, delimiter)
    return body, dash, quoted


def normalize_heredoc_body(body: str, delimiter: str) -> str:
    """Repair tree-sitter quirks on concatenated delimiters (<<EN'D').

    tree-sitter sometimes fails to match the closing line against a
    concatenated delimiter: the body swallows the delimiter line, or
    loses its final newline to heredoc_end. Bash strips quoting from
    the delimiter before matching and bodies always end with a newline.
    """
    clean = delimiter.replace("'", "").replace('"', "")
    suffix = clean + "\n"
    if body.endswith(suffix):
        head = body[:-len(suffix)]
        if not head or head.endswith("\n"):
            body = head
    if body and not body.endswith("\n"):
        body += "\n"
    return body


def get_process_sub_direction(
        node: tree_sitter.Node) -> ProcessSubDirection | None:
    """Return the direction marker on a process_substitution node.

    `<(cmd)` is INPUT (inner stdout feeds our stdin), `>(cmd)` is OUTPUT
    (our stdout feeds inner stdin). Returns None if the open token is missing.
    """
    if not node.children:
        return None
    open_token = node.children[0].type
    if open_token == "<(":
        return ProcessSubDirection.INPUT
    if open_token == ">(":
        return ProcessSubDirection.OUTPUT
    return None


def get_process_sub_body(node: tree_sitter.Node) -> str:
    text = get_text(node)
    if text.startswith(("<(", ">(")) and text.endswith(")"):
        return text[2:-1]
    return text


def get_function_name(node: tree_sitter.Node) -> str:
    """Get function name."""
    return get_text(node.named_children[0])


def get_function_body(node: tree_sitter.Node) -> FunctionBody:
    """Get function body commands.

    Returns the compound_statement's children list so
    multi-statement bodies are preserved.
    """
    for c in node.named_children:
        if c.type == NT.COMPOUND_STATEMENT:
            return list(c.named_children)
    raise ValueError("function definition has no compound body")
