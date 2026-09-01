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

import tree_sitter

from mirage.shell.parse.constants import (CD_ANCHORS, DECL_PRINTER_HEADS,
                                          IMPLICIT_HEAD_READS, NAMEREF_HEADS)
from mirage.shell.parse.names import (command_args, command_invocations,
                                      literal_text, walk_named_outside_defs)


def _declaration_parts(
        node: tree_sitter.Node
) -> tuple[str, list[str], list[tree_sitter.Node]]:
    """Split a declaration_command into head word, flag words, operands.

    Args:
        node (tree_sitter.Node): a ``declaration_command`` node.
    """
    head = ""
    if node.children:
        text = node.children[0].text
        head = text.decode() if text else ""
    flags: list[str] = []
    operands: list[tree_sitter.Node] = []
    for child in node.children[1:]:
        if child.type == "word":
            text = child.text
            word = text.decode() if text else ""
            if word.startswith("-"):
                flags.append(word)
            else:
                operands.append(child)
        elif child.is_named:
            operands.append(child)
    return head, flags, operands


def _flag_has(flags: list[str], letter: str) -> bool:
    """Whether a single-dash flag word carries the letter.

    Args:
        flags (list[str]): flag words as typed (``-p``, ``-nr``).
        letter (str): the option letter looked for.
    """
    return any(
        flag.startswith("-") and not flag.startswith("--")
        and letter in flag[1:] for flag in flags)


def _env_exclusions(args: list[tree_sitter.Node]) -> frozenset[str] | None:
    """Names an ``env`` invocation provably keeps from the environment
    it hands on: None when it reads no existing name at all, else the
    set a whole-environment read may skip.

    Scanned with the builtin's own option grammar: ``--`` ends the
    options, ``-u``/``--unset`` consume a value (so ``-u -i`` unsets a
    variable named ``-i`` rather than clearing) and add it to the
    exclusions, the leading ``NAME=VALUE`` operands override and
    exclude their names, and the first other operand ends the scan.
    ``-i``, ``--ignore-environment`` or the lone ``-`` empties the
    start entirely, and an option the builtin refuses stops it from
    running at all; both answer None. The scan is left to right like
    the builtin's, so everything consumed before the first word no
    static read can spell keeps its effect whatever that word turns
    out to be, and nothing after it is claimed: a dynamic word may be
    the command, demoting every later word to an argument.

    Args:
        args (list[tree_sitter.Node]): the invocation's argument nodes.
    """
    excluded: set[str] = set()
    i = 0
    while i < len(args):
        literal = literal_text(args[i])
        if literal is None:
            return frozenset(excluded)
        if literal == "--":
            i += 1
            break
        if literal in ("-i", "--ignore-environment", "-"):
            return None
        if literal == "--unset":
            if i + 1 >= len(args):
                return None
            value = literal_text(args[i + 1])
            if value is not None:
                excluded.add(value)
            i += 2
            continue
        if literal.startswith("--unset="):
            excluded.add(literal[len("--unset="):])
            i += 1
            continue
        if literal in ("-0", "--null"):
            i += 1
            continue
        if literal.startswith("--"):
            return None
        if literal.startswith("-") and len(literal) > 1:
            step = 1
            for pos, ch in enumerate(literal[1:]):
                if ch == "i":
                    return None
                if ch == "u":
                    rest = literal[pos + 2:]
                    if rest:
                        excluded.add(rest)
                    elif i + 1 < len(args):
                        value = literal_text(args[i + 1])
                        if value is not None:
                            excluded.add(value)
                        step = 2
                    else:
                        return None
                    break
                if ch != "0":
                    return None
            i += step
            continue
        break
    while i < len(args):
        literal = literal_text(args[i])
        if literal is None:
            return frozenset(excluded)
        if "=" not in literal or literal.startswith("="):
            break
        excluded.add(literal.partition("=")[0])
        i += 1
    return frozenset(excluded)


def _prefix_assignment_names(node: tree_sitter.Node) -> frozenset[str]:
    """Names a command's assignment prefixes provably override.

    ``TOKEN=local printenv TOKEN`` hands the command an environment
    whose TOKEN is the override, so an environment read through that
    invocation cannot observe the standing value whatever the override
    expands to; the value's own reads are the walk's business. ``+=``
    appends to the standing value and proves nothing.

    Args:
        node (tree_sitter.Node): a ``command`` node.
    """
    out: set[str] = set()
    for child in node.named_children:
        if child.type != "variable_assignment":
            continue
        if any(part.type == "+=" for part in child.children):
            continue
        name_node = child.child_by_field_name("name")
        if name_node is None or name_node.type != "variable_name":
            continue
        text = name_node.text
        if text:
            out.add(text.decode())
    return frozenset(out)


def env_reads(
        node: tree_sitter.Node) -> tuple[bool, frozenset[str], frozenset[str]]:
    """How the line's environment-rendering commands read names.

    Returns ``(whole, names, excluded)``: whether some command renders
    the whole environment, the names printing forms read explicitly,
    and the names every whole-environment read provably skips. Only a
    printing form selects everything: ``env`` on any invocation (bare
    it prints every exported name, and with arguments it hands the
    snapshot to the command it runs) unless a literal ``-i``,
    ``--ignore-environment`` or lone ``-`` proves it starts empty, a
    bare ``set``, a bare ``printenv``, and a declaring builtin with no
    operands (``export``, ``declare -p``). ``printenv NAME`` and
    ``declare -p NAME`` read exactly the named variables, and a
    mutating form (``export NAME=v``, ``declare -x NAME``, ``set -u``)
    reads nothing here, so an unavailable source cannot fail the write
    that would replace its pointer. A print target no static read can
    spell (``printenv $x``) falls back to the whole environment.

    Exclusions are per invocation: an assignment prefix overrides its
    name for exactly that command's environment, and ``env``'s ``-u``,
    ``--unset`` and ``NAME=VALUE`` words remove or override theirs
    (``_env_exclusions``), so ``env -u TOKEN printenv TOKEN`` cannot
    observe TOKEN however the whole snapshot is handed on. A print
    target so excluded is dropped rather than reported. ``excluded``
    is the intersection across the node's whole-environment reads,
    because a name is skippable only when every such read skips it.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    whole = False
    excluded: frozenset[str] | None = None
    names: set[str] = set()
    for n in walk_named_outside_defs(node):
        if n.type == "command":
            name_node = n.child_by_field_name("name")
            text = name_node.text if name_node is not None else None
            head = text.decode() if text else ""
            prefix = _prefix_assignment_names(n)
            skipped: frozenset[str] | None = None
            if head == "env":
                scanned = _env_exclusions(command_args(n))
                if scanned is not None:
                    skipped = prefix | scanned
            elif head == "set":
                if not command_args(n):
                    skipped = prefix
            elif head == "printenv":
                read_any = False
                for child in command_args(n):
                    literal = literal_text(child)
                    if literal is None:
                        skipped = prefix
                        read_any = True
                    elif not literal.startswith("-"):
                        if literal not in prefix:
                            names.add(literal)
                        read_any = True
                if not read_any:
                    skipped = prefix
            if skipped is not None:
                whole = True
                excluded = (skipped if excluded is None else excluded
                            & skipped)
        elif n.type == "declaration_command":
            head, flags, operands = _declaration_parts(n)
            if head not in DECL_PRINTER_HEADS:
                continue
            selected = False
            if not operands:
                selected = True
            elif _flag_has(flags, "p"):
                for operand in operands:
                    if operand.type == "variable_name":
                        text = operand.text
                        if text:
                            names.add(text.decode())
                    elif operand.type != "variable_assignment":
                        selected = True
            if selected:
                whole = True
                excluded = frozenset()
    return whole, frozenset(names), excluded or frozenset()


def opaque_reads(node: tree_sitter.Node) -> bool:
    """Whether the line reads names no static walk can spell.

    Two constructs defeat ``referenced_names``: an indirect expansion
    (``${!name}`` reads the variable the *value* of ``name`` names, and
    the ``${!p*}``/``${!p@}`` forms enumerate by prefix), and a nameref
    declared on the line itself (``declare -n r=T; echo $r`` reads T
    before any session record says so). A nameref from an earlier line
    is not opaque: the session records its target, which ``deref``
    resolves.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    for n in walk_named_outside_defs(node):
        if n.type == "expansion" and any(c.type == "!" for c in n.children):
            return True
        if n.type == "declaration_command":
            head, flags, _ = _declaration_parts(n)
            if head in NAMEREF_HEADS and _flag_has(flags, "n"):
                return True
    return False


def _cd_reads(args: tuple[str | None, ...]) -> frozenset[str]:
    """The names one ``cd`` invocation reads implicitly.

    Bare ``cd`` goes to ``$HOME``, ``cd -`` to ``$OLDPWD``, and a
    searchable relative operand tries ``$CDPATH`` first. Option words
    (``-L``/``-P``/``--``) are not operands, and a word no static read
    can spell may expand to any of the shapes, so it selects all three.

    Args:
        args (tuple[str | None, ...]): the invocation's argument words
            (``command_invocations``), None for a dynamic word.
    """
    operands: list[str] = []
    for arg in args:
        if arg is None:
            return frozenset({"HOME", "OLDPWD", "CDPATH"})
        if arg == "-" or not arg.startswith("-"):
            operands.append(arg)
    if not operands:
        return frozenset({"HOME"})
    target = operands[0]
    if target == "-":
        return frozenset({"OLDPWD"})
    if target.startswith(CD_ANCHORS) or target in (".", ".."):
        return frozenset()
    return frozenset({"CDPATH"})


def implicit_reads(node: tree_sitter.Node) -> frozenset[str]:
    """Names the program reads without a ``$NAME`` in the text.

    Tilde expansion resolves ``~`` and ``~/...`` against ``$HOME``
    wherever a word expands (patterns and redirect targets included),
    and the word scan mirrors ``expand_tilde`` exactly: ``~user``, a
    mid-word tilde and a quoted one stay literal. ``cd`` reads
    ``$HOME`` bare, ``$OLDPWD`` for ``-`` and ``$CDPATH`` for a
    searchable relative operand; ``read`` splits on ``$IFS``;
    ``getopts`` resumes from ``$OPTIND`` and consults ``$OPTERR``.
    These join the fill plan exactly as a spelled reference does, so a
    managed ``HOME`` fetches for ``echo ~`` the way it does for
    ``echo $HOME``.

    Args:
        node (tree_sitter.Node): root node from parse().
    """
    out: set[str] = set()
    for n in walk_named_outside_defs(node):
        if n.type == "word":
            text = n.text
            if text is not None and (text == b"~" or text.startswith(b"~/")):
                out.add("HOME")
    for head, args in command_invocations(node):
        reads = IMPLICIT_HEAD_READS.get(head or "")
        if reads is not None:
            out |= reads
        if head == "cd":
            out |= _cd_reads(args)
    return frozenset(out)
