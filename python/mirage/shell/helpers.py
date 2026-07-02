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

from enum import StrEnum

import tree_sitter

from mirage.shell.types import NodeType as NT
from mirage.shell.types import Redirect, RedirectKind


class ProcessSubDirection(StrEnum):
    INPUT = "input"
    OUTPUT = "output"


def get_text(node: tree_sitter.Node) -> str:
    """Get the text content of a node."""
    return node.text.decode()


def get_command_name(node: tree_sitter.Node) -> str:
    """Get the command name string."""
    for c in node.named_children:
        if c.type == NT.COMMAND_NAME:
            return c.text.decode()
    return ""


def get_parts(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """Get command parts as child nodes.

    Preserves expansion nodes for later processing.
    """
    _SKIP = frozenset({NT.FILE_REDIRECT, NT.HERESTRING_REDIRECT})
    return [c for c in node.named_children if c.type not in _SKIP]


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


def get_subshell_body(node: tree_sitter.Node) -> list[tree_sitter.Node]:
    """Get body commands from subshell."""
    return list(node.named_children)


def get_redirect_parts(
    node: tree_sitter.Node,
) -> tuple[tree_sitter.Node, str, bool, RedirectKind]:  # noqa: E125,E501
    """Get (command, target, append, stream) for the first redirect.

    Legacy helper — use get_redirects for full redirect support.
    """
    command, redirects = get_redirects(node)
    if not redirects:
        return command, "", False, RedirectKind.STDOUT
    r = redirects[0]
    target = r.target if isinstance(r.target, str) else ""
    return command, target, r.append, r.kind


def _is_last_cmd_redirect(body: tree_sitter.Node, redirects: list) -> bool:
    """Check if redirects belong to the last command, not the whole list.

    tree-sitter-bash parses ``a || echo x > file`` as
    ``(a || echo x) > file`` but bash treats it as
    ``a || (echo x > file)``. Redirects never apply to an entire
    &&/|| chain — they bind to the last simple command.
    """
    return body.type == NT.LIST and len(redirects) > 0


def get_redirects(
        node: tree_sitter.Node,  # noqa: E125
) -> tuple[tree_sitter.Node, list[Redirect]]:
    """Parse all redirects from a redirected_statement."""
    nc = node.named_children
    command = nc[0]
    redirects: list[Redirect] = []

    for child in nc[1:]:
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
                         kind=RedirectKind.HEREDOC,
                         pipeline=pipe_node,
                         expand_vars=not quoted))
            continue

        if child.type == NT.HERESTRING_REDIRECT:
            content = ""
            for sc in child.children:
                if sc.is_named and sc.type != "<<<":
                    content = get_text(sc)
                    break
            redirects.append(
                Redirect(fd=0, target=content, kind=RedirectKind.HERESTRING))
            continue

        if child.type != NT.FILE_REDIRECT:
            continue

        fd = 1
        target = ""
        target_node = None
        kind = RedirectKind.STDOUT
        append = False
        dup_fd = None

        for c in child.children:
            if c.type == NT.FILE_DESCRIPTOR:
                fd = int(get_text(c))
            elif c.type == NT.REDIRECT_OUT:
                pass
            elif c.type == NT.REDIRECT_APPEND:
                append = True
            elif c.type == NT.REDIRECT_IN:
                kind = RedirectKind.STDIN
                fd = 0
            elif c.type == NT.REDIRECT_STDERR:
                kind = RedirectKind.STDERR_TO_STDOUT
            elif c.type == NT.REDIRECT_BOTH:
                kind = RedirectKind.STDOUT
                fd = -1
            elif c.type == NT.REDIRECT_BOTH_APPEND:
                kind = RedirectKind.STDOUT
                fd = -1
                append = True
            elif c.type == NT.NUMBER:
                dup_fd = int(get_text(c))

        _TARGET_TYPES = frozenset({
            NT.WORD,
            NT.CONCATENATION,
            NT.SIMPLE_EXPANSION,
            NT.EXPANSION,
            NT.COMMAND_SUBSTITUTION,
            NT.STRING,
        })
        for c in child.named_children:
            if c.type in _TARGET_TYPES:
                target = get_text(c)
                target_node = c
                break

        if dup_fd is not None and kind == RedirectKind.STDERR_TO_STDOUT:
            if fd == 2 and dup_fd == 1:
                kind = RedirectKind.STDERR_TO_STDOUT
                target = dup_fd
            elif fd == 1 and dup_fd == 2:
                kind = RedirectKind.STDOUT
                fd = 1
                target = 2
            else:
                target = dup_fd

        if fd == -1:
            kind = RedirectKind.STDOUT
            redirects.append(
                Redirect(fd=-1,
                         target=target,
                         target_node=target_node,
                         kind=kind,
                         append=append))
            continue

        if fd == 2 and kind != RedirectKind.STDERR_TO_STDOUT:
            kind = RedirectKind.STDERR

        redirects.append(
            Redirect(fd=fd,
                     target=target,
                     target_node=target_node,
                     kind=kind,
                     append=append))

    return command, redirects


def get_redirect_target_node(
        node: tree_sitter.Node) -> tree_sitter.Node | None:
    """Get the expandable target node from the first redirect."""
    _, redirects = get_redirects(node)
    if not redirects:
        return None
    return redirects[0].target_node


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
    condition = nc[0]
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
) -> list[tuple[str, tree_sitter.Node | None]]:  # noqa: E125,E501
    """Get (pattern, body) pairs from case."""
    items: list[tuple[list[str], tree_sitter.Node | None]] = []
    for c in node.named_children:
        if c.type == NT.CASE_ITEM:
            patterns = []
            body = None
            for child in c.children:
                if child.type in (NT.EXTGLOB_PATTERN, NT.WORD,
                                  NT.CONCATENATION, NT.STRING):
                    patterns.append(get_text(child))
                elif child.is_named and child.type not in (
                        NT.EXTGLOB_PATTERN, NT.WORD, NT.CONCATENATION,
                        NT.STRING) and child.type != "|":
                    body = child
                    break
            if not patterns:
                patterns = [get_text(c.named_children[0])]
            items.append((patterns, body))
    return items


def get_declaration_assignments(node: tree_sitter.Node) -> list[str]:
    """Get assignment strings from declaration_command.

    Works for export, local, declare.
    """
    return [
        get_text(c) for c in node.named_children
        if c.type == NT.VARIABLE_ASSIGNMENT
    ]


def get_declaration_keyword(node: tree_sitter.Node) -> str:
    """Get keyword (export/local/declare) from declaration."""
    return node.children[0].type


def get_unset_names(node: tree_sitter.Node) -> list[str]:
    """Get variable names from unset_command."""
    return [
        get_text(c) for c in node.named_children if c.type == NT.VARIABLE_NAME
    ]


def get_test_argv(node: tree_sitter.Node) -> list[str]:
    """Get test arguments from test_command ([ ] or [[ ]]).

    Returns the inner expression text.
    """
    return [get_text(c) for c in node.named_children]


def get_command_assignments(node: tree_sitter.Node) -> list[str]:
    """Get prefix assignments from a command (A=1 B=2 cmd).

    Returns list of assignment strings.
    """
    return [
        get_text(c) for c in node.named_children
        if c.type == NT.VARIABLE_ASSIGNMENT
    ]


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
    quoted = (delimiter.startswith("'")
              and delimiter.endswith("'")) or (delimiter.startswith('"')
                                               and delimiter.endswith('"'))
    dash = False
    for c in redirect_node.children:
        if c.type == "<<-":
            dash = True
            break
    if dash and body:
        body = "\n".join(line.lstrip("\t") for line in body.split("\n"))
    return body, dash, quoted


def get_herestring_content(node: tree_sitter.Node) -> str:
    """Get content from herestring_redirect (<<<)."""
    for c in node.named_children:
        if c.type == NT.HERESTRING_REDIRECT:
            return get_text(c.named_children[0])
    return ""


def get_process_sub_command(node: tree_sitter.Node) -> tree_sitter.Node:
    """Get inner command from process_substitution."""
    return node.named_children[0]


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


def get_function_name(node: tree_sitter.Node) -> str:
    """Get function name."""
    return get_text(node.named_children[0])


def get_function_body(node: tree_sitter.Node) -> list[tree_sitter.Node] | None:
    """Get function body commands.

    Returns the compound_statement's children list so
    multi-statement bodies are preserved.
    """
    for c in node.named_children:
        if c.type == NT.COMPOUND_STATEMENT:
            return list(c.named_children)
    return None
