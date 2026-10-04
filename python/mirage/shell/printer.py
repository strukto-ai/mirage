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
from collections.abc import Sequence

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.escapes import decode_ansi_c
from mirage.shell.helpers import (
    REDIRECT_NODE_TYPES,
    get_case_items,
    get_for_parts,
    get_function_redirects,
    get_text,
)
from mirage.shell.parse.constants import BASH_KEYWORDS
from mirage.shell.parse.heredoc.reader import delimiter_end
from mirage.shell.parse.heredoc.types import Heredoc
from mirage.shell.types import FunctionBody, TSNodeLike
from mirage.shell.types import NodeType as NT

_INDENT = "    "
_CONTINUATION = re.compile(r"\\\n[ \t]*")
# A name bash would read as a reserved word is printed after `function`.
_RESERVED = BASH_KEYWORDS | {"!", "{", "}", "[[", "]]", "time", "coproc"}


def function_text(name: str, body: FunctionBody) -> str:
    """A function as ``declare -f`` and ``type`` print it.

    bash prints its own rendering of the parsed definition, not the text
    that was typed (print_cmd.c): a body of statements one per line with
    four-space indents, ``;`` between them, ``elif`` as an ``if`` nested
    in ``else``, redirects respelled after the words (``>&2`` is
    ``1>&2``), ``$'...'`` decoded into single quotes, and every
    substitution's command printed the same way.

    Args:
        name (str): the function's name.
        body (FunctionBody): the body the definition stored.
    """
    return _Printer(True).definition(name, _definition(body), "")


def _definition(body: FunctionBody) -> TSNodeLike:
    node = body[0]
    if node.parent is None and node.type == NT.REDIRECTED_STATEMENT:
        node = node.children[0]
    parent = node.parent
    while parent is not None and parent.type != NT.FUNCTION_DEFINITION:
        parent = parent.parent
    return parent if parent is not None else node


def _requote(text: str) -> str:
    return "'" + text.replace("'", "'\\''") + "'"


class _Printer:
    """One rendering: inside a function body or a substitution's own
    top level, which prints its ``;`` and newline separators as typed.

    Heredoc bodies wait for the end of the line their operator is on.
    """

    def __init__(self, in_function: bool) -> None:
        self.in_function = in_function
        self.deferred: list[str] = []

    def definition(self, name: str, node: TSNodeLike, indent: str) -> str:
        body = node.child_by_field_name("body")
        inner = indent + _INDENT
        if body is not None and body.type == NT.COMPOUND_STATEMENT:
            text = self.statements(body.children, inner, False)
        else:
            text = self.command(body, inner) if body is not None else ""
        keyword = indent or name in _RESERVED
        head = ("function " if keyword else "") + f"{name} () \n"
        return (
            head
            + indent
            + "{ \n"
            + inner
            + text
            + "\n"
            + indent
            + "}"
            + self.redirects(get_function_redirects(node))
        )

    def statements(
        self, children: Sequence[TSNodeLike], indent: str, trailing: bool
    ) -> str:
        """A list of statements: each on its own line under ``indent``,
        ``;`` between them, after the last one too when ``trailing`` (the
        body of an ``if`` or a loop); ``&`` keeps the next on its line.

        Args:
            children (Sequence[TSNodeLike]): the container's children.
            indent (str): the indent of each line.
            trailing (bool): whether the last statement ends with ``;``.
        """
        parts: list[TSNodeLike] = []
        background: set[int] = set()
        newline_after: set[int] = set()
        for child in children:
            if child.type == "&" and parts:
                background.add(len(parts) - 1)
            elif child.is_named and child.type != NT.COMMENT:
                if parts and self._newline_between(parts[-1], child):
                    newline_after.add(len(parts) - 1)
                parts.append(child)
        out = ""
        for index, part in enumerate(parts):
            out += self.command(part, indent)
            heredoc = bool(self.deferred)
            if heredoc:
                out += "\n" + "".join(self.deferred)
                self.deferred = []
            last = index == len(parts) - 1
            if index in background:
                out += " &" if last else " & "
            elif heredoc:
                out += "" if last else "\n" + indent
            elif not last:
                out += (
                    ";\n" + indent
                    if self.in_function
                    else "\n"
                    if index in newline_after
                    else "; "
                )
            elif trailing:
                out += ";"
        return out

    @staticmethod
    def _newline_between(left: TSNodeLike, right: TSNodeLike) -> bool:
        parent = left.parent
        if parent is None:
            return False
        source = parent.text or b""
        between = source[
            left.end_byte - parent.start_byte : right.start_byte
            - parent.start_byte
        ]
        return b"\n" in between and b";" not in between

    def command(self, node: TSNodeLike, indent: str) -> str:
        """One statement, its compound bodies indented under ``indent``.

        Args:
            node (TSNodeLike): the statement.
            indent (str): the indent of the line it starts on.
        """
        kind = node.type
        if kind == NT.REDIRECTED_STATEMENT:
            body = node.named_children[0]
            if body.type in REDIRECT_NODE_TYPES:
                return self.redirects(node.named_children).lstrip()
            redirects = [
                c
                for c in node.named_children[1:]
                if c.type in REDIRECT_NODE_TYPES
            ]
            if body.type == NT.FUNCTION_DEFINITION:
                return self.definition(
                    get_text(body.named_children[0]), body, indent
                )
            return self.command(body, indent) + self.redirects(redirects)
        if kind == NT.COMMAND:
            words = [
                self.word(c)
                for c in node.named_children
                if c.type not in REDIRECT_NODE_TYPES
            ]
            redirects = [
                c for c in node.named_children if c.type in REDIRECT_NODE_TYPES
            ]
            return " ".join(words) + self.redirects(redirects)
        if kind == NT.PIPELINE:
            return self._pipeline(node, indent)
        if kind == NT.LIST:
            left, right = node.named_children[0], node.named_children[1]
            op = next(c.type for c in node.children if not c.is_named)
            return (
                self.command(left, indent)
                + f" {op} "
                + self.command(right, indent)
            )
        if kind == "negated_command":
            return "! " + self.command(node.named_children[0], indent)
        if kind == "timed_statement":
            portable = bool(getattr(node, "timing", (False,))[0])
            return ("time -p " if portable else "time ") + self.command(
                node.named_children[0], indent
            )
        if kind == NT.SUBSHELL:
            return "( " + self.statements(node.children, indent, False) + " )"
        if kind == "test_command" and get_text(node).startswith("[["):
            return "[[ " + self.condition(node.named_children[0]) + " ]]"
        if kind == NT.COMPOUND_STATEMENT:
            if node.children and node.children[0].type == "((":
                return _CONTINUATION.sub("", get_text(node))
            inner = indent + _INDENT
            return (
                "{ \n"
                + inner
                + self.statements(node.children, inner, False)
                + "\n"
                + indent
                + "}"
            )
        if kind == NT.IF_STATEMENT:
            return self._if(node, indent)
        if kind in (NT.WHILE_STATEMENT, "until_statement"):
            return self._while(node, indent)
        if kind == NT.FOR_STATEMENT:
            return self._for(node, indent)
        if kind == "c_style_for_statement":
            return self._cfor(node, indent)
        if kind == NT.CASE_STATEMENT:
            return self._case(node, indent)
        if kind == NT.FUNCTION_DEFINITION:
            return self.definition(
                get_text(node.named_children[0]), node, indent
            )
        if kind in (
            "variable_assignments",
            "declaration_command",
            "unset_command",
        ):
            words = [self.word(c) for c in node.named_children]
            if node.children and not node.children[0].is_named:
                words.insert(0, get_text(node.children[0]))
            return " ".join(words)
        return self.word(node)

    def condition(self, node: TSNodeLike) -> str:
        """A ``[[ ]]`` expression as bash prints its parsed form: one space
        around each operator, and a bare operand tested with ``-n``.

        Args:
            node (TSNodeLike): the expression inside the brackets.
        """
        kind = node.type
        named = node.named_children
        if kind == "binary_expression" and len(named) == 2:
            op = next(get_text(c) for c in node.children if not c.is_named)
            if op in ("&&", "||"):
                return (
                    self.condition(named[0])
                    + f" {op} "
                    + self.condition(named[1])
                )
            return self.word(named[0]) + f" {op} " + self.word(named[1])
        if kind == "unary_expression" and named:
            op = get_text(node.children[0])
            if op == "!" and node.children[0].end_byte < named[-1].start_byte:
                return "! " + self.condition(named[-1])
            if op != "!":
                return op + " " + self.word(named[-1])
        if kind == "parenthesized_expression" and named:
            return "( " + self.condition(named[0]) + " )"
        return "-n " + self.word(node)

    def _pipeline(self, node: TSNodeLike, indent: str) -> str:
        out = ""
        for child in node.children:
            if child.type == "|":
                out += " |"
            elif child.type == "|&":
                out += " 2>&1 |"
            elif child.is_named:
                if out:
                    out += (
                        "\n" + "".join(self.deferred) + "  "
                        if self.deferred
                        else " "
                    )
                    self.deferred = []
                out += self.command(child, indent)
        return out

    def _body(self, node: TSNodeLike | None, indent: str) -> str:
        inner = indent + _INDENT
        children = list(node.children) if node is not None else []
        return "\n" + inner + self.statements(children, inner, True)

    def _if(self, node: TSNodeLike, indent: str) -> str:
        branches: list[tuple[list[TSNodeLike], list[TSNodeLike]]] = []
        otherwise: list[TSNodeLike] | None = None
        condition: list[TSNodeLike] = []
        body: list[TSNodeLike] = []
        target = condition
        for child in node.children:
            if child.type in ("if", "elif"):
                target = condition
            elif child.type == "then":
                target = body
            elif child.type in (NT.ELIF_CLAUSE, NT.ELSE_CLAUSE, "fi"):
                if condition or body:
                    branches.append((condition, body))
                    condition, body = [], []
                if child.type == NT.ELIF_CLAUSE:
                    for part in child.children:
                        if part.type == "elif":
                            target = condition
                        elif part.type == "then":
                            target = body
                        else:
                            target.append(part)
                    branches.append((condition, body))
                    condition, body = [], []
                elif child.type == NT.ELSE_CLAUSE:
                    otherwise = [
                        part for part in child.children if part.type != "else"
                    ]
            else:
                target.append(child)
        return self._branches(branches, otherwise, indent)

    def _branches(
        self,
        branches: list[tuple[list[TSNodeLike], list[TSNodeLike]]],
        otherwise: list[TSNodeLike] | None,
        indent: str,
    ) -> str:
        condition, body = branches[0]
        inner = indent + _INDENT
        out = (
            "if "
            + self.statements(condition, indent, False)
            + "; then\n"
            + inner
            + self.statements(body, inner, True)
            + "\n"
        )
        if len(branches) > 1:
            out += (
                indent
                + "else\n"
                + inner
                + self._branches(branches[1:], otherwise, inner)
                + ";\n"
            )
        elif otherwise is not None:
            out += (
                indent
                + "else\n"
                + inner
                + self.statements(otherwise, inner, True)
                + "\n"
            )
        return out + indent + "fi"

    def _while(self, node: TSNodeLike, indent: str) -> str:
        condition = [
            c
            for c in node.children
            if c.type not in ("while", "until", NT.DO_GROUP)
        ]
        group = next((c for c in node.children if c.type == NT.DO_GROUP), None)
        return (
            node.children[0].type
            + " "
            + self.statements(condition, indent, False)
            + "; do"
            + self._group(group, indent)
        )

    def _group(self, group: TSNodeLike | None, indent: str) -> str:
        children = [
            c
            for c in (group.children if group is not None else [])
            if c.type not in ("do", "done")
        ]
        inner = indent + _INDENT
        return (
            "\n"
            + inner
            + self.statements(children, inner, True)
            + "\n"
            + indent
            + "done"
        )

    def _for(self, node: TSNodeLike, indent: str) -> str:
        variable, values, _ = get_for_parts(node)
        words = " ".join(self.word(v) for v in values)
        group = next((c for c in node.children if c.type == NT.DO_GROUP), None)
        return (
            node.children[0].type
            + f" {variable} in {words};\n"
            + indent
            + "do"
            + self._group(group, indent)
        )

    def _cfor(self, node: TSNodeLike, indent: str) -> str:
        source = node.text or b""
        start = node.start_byte
        slots: list[str] = []
        begin = None
        for child in node.children:
            if child.type in ("((", ";", "))") and (
                begin is not None or child.type == "(("
            ):
                if begin is not None:
                    text = decode_text(
                        source[begin - start : child.start_byte - start]
                    ).lstrip()
                    slots.append(text or "1")
                begin = child.end_byte if child.type != "))" else None
                if child.type == "))":
                    break
        group = next((c for c in node.children if c.type == NT.DO_GROUP), None)
        return (
            "for (("
            + "; ".join(slots)
            + "))\n"
            + indent
            + "do"
            + self._group(group, indent)
        )

    def _case(self, node: TSNodeLike, indent: str) -> str:
        item_indent = indent + _INDENT
        body_indent = item_indent + _INDENT
        out = "case " + self.word(node.named_children[0]) + " in \n"
        items = [c for c in node.named_children if c.type == NT.CASE_ITEM]
        for item, (patterns, body, _) in zip(items, get_case_items(node)):
            text = self.statements(body, body_indent, False)
            out += (
                item_indent
                + " | ".join(self.word(p) for p in patterns)
                + ")\n"
                + (body_indent + text if text else "")
                + "\n"
                + item_indent
                + _terminator(node, item)
                + "\n"
            )
        return out + indent + "esac"

    def redirects(self, nodes: Sequence[TSNodeLike]) -> str:
        return "".join(
            " " + self.redirect(n)
            for n in nodes
            if n.type in REDIRECT_NODE_TYPES
        )

    def redirect(self, node: TSNodeLike) -> str:
        """A redirect as bash respells it: a duplication or a close names
        its descriptor (``1>&2``), a file one only a descriptor other than
        the operator's own (``> f``, ``2> f``), and a heredoc's body waits
        for the end of the line.

        Args:
            node (TSNodeLike): a file or heredoc redirect.
        """
        fd = next(
            (
                get_text(c)
                for c in node.children
                if c.type == NT.FILE_DESCRIPTOR
            ),
            None,
        )
        document = getattr(node, "heredoc", None)
        if document is not None or node.type == NT.HEREDOC_REDIRECT:
            return self._heredoc(node, fd, document)
        text = get_text(node)
        op = next(
            (
                get_text(c)
                for c in node.children
                if not c.is_named and c.type not in ("(", ")")
            ),
            "",
        )
        target = next(
            (c for c in node.named_children if c.type != NT.FILE_DESCRIPTOR),
            None,
        )
        word = self.word(target) if target is not None else ""
        if text.lstrip("0123456789").startswith("<<<"):
            return f"{fd or ''}<<< {word}"
        if op in (">&", "<&", ">&-", "<&-"):
            default = "1" if op.startswith(">") else "0"
            if target is not None and target.type != NT.NUMBER and op == ">&":
                return f"&> {word}"
            return f"{fd or default}{op}{word}"
        if op == "<>":
            return f"{fd or '0'}<> {word}"
        if op in ("&>", "&>>"):
            return f"{op} {word}"
        default = "0" if op == "<" else "1"
        shown = fd if fd is not None and fd.lstrip("0") != default else ""
        if fd is not None and fd.lstrip("0") == "" and default == "0":
            shown = ""
        return f"{shown}{op} {word}"

    def _heredoc(
        self, node: TSNodeLike, fd: str | None, document: Heredoc | None
    ) -> str:
        source = getattr(node, "source_text", node.text) or b""
        text = decode_text(source)
        operator = "<<-" if text.startswith("<<-") else "<<"
        start = len(operator)
        while start < len(text) and text[start] in " \t":
            start += 1
        end = delimiter_end(encode_text(text), start) or start
        word = text[start:end]
        if document is not None:
            body = decode_text(document.body)
            delimiter, quoted = document.delimiter, document.quoted
        else:
            body = get_text(
                next(
                    (c for c in node.children if c.type == "heredoc_body"),
                    node,
                )
            )
            delimiter = word.strip("'\"")
            quoted = delimiter != word
        self.deferred.append(body + delimiter + "\n")
        shown = fd if fd is not None and fd.lstrip("0") != "" else ""
        return shown + operator + (_requote(delimiter) if quoted else word)

    def word(self, node: TSNodeLike) -> str:
        """A word as typed, but for what bash rewrites: ``$'...'`` decoded
        into single quotes, ``$"..."`` as a plain string, a substitution's
        command printed afresh, and a line continuation dropped.

        Args:
            node (TSNodeLike): the word.
        """
        kind = node.type
        if kind == NT.ANSI_C_STRING:
            return _requote(decode_ansi_c(get_text(node)[2:-1]))
        if kind == "translated_string":
            return get_text(node)[1:]
        if kind == NT.COMMAND_SUBSTITUTION and get_text(node).startswith("$("):
            inner = [c for c in node.children if c.type not in ("$(", ")")]
            printer = _Printer(False)
            return "$(" + printer.statements(inner, "", False) + ")"
        if not node.children:
            return _CONTINUATION.sub("", get_text(node))
        out = ""
        for part in _parts(node):
            out += (
                _CONTINUATION.sub("", part)
                if isinstance(part, str)
                else self.word(part)
            )
        return out


def _terminator(case: TSNodeLike, item: TSNodeLike) -> str:
    # As typed: the parser spells a last arm's `;;&` as `;;`.
    token = next(
        (c for c in item.children if c.type in (";;", ";&", ";;&")), None
    )
    if token is None:
        return ";;"
    text = get_text(token)
    source = case.text or b""
    after = source[token.end_byte - case.start_byte :][:1]
    return text + "&" if text == ";;" and after == b"&" else text


def _parts(node: TSNodeLike) -> list[str | TSNodeLike]:
    source = node.text or b""
    end = node.start_byte
    parts: list[str | TSNodeLike] = []
    for child in node.children:
        if child.start_byte > end:
            parts.append(
                decode_text(
                    source[
                        end - node.start_byte : child.start_byte
                        - node.start_byte
                    ]
                )
            )
        end = child.end_byte
        parts.append(child)
    if end < node.end_byte:
        parts.append(decode_text(source[end - node.start_byte :]))
    return parts
