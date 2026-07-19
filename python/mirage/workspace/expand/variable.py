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

import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import tree_sitter

from mirage.shell.arith import evaluate_arith
from mirage.shell.call_stack import CallStack
from mirage.shell.errors import ArithError, ExitSignal
from mirage.shell.helpers import get_text
from mirage.shell.types import NodeType as NT
from mirage.utils.fnmatch import fnmatch
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir

ExpandChild = Callable[[tree_sitter.Node], Awaitable[str]]

_PARAM_OPS = frozenset({
    ":-", "-", ":+", "+", ":?", "?", ":=", "=", "#", "##", "%", "%%", "/",
    "//", "/#", "/%", ":", "^", "^^", ",", ",,", "!"
})

_REPLACE_OPS = frozenset({"/", "//", "/#", "/%"})

_STRIP_OPS = frozenset({"#", "##", "%", "%%"})

_CASE_OPS = frozenset({"^", "^^", ",", ",,"})

# Ops whose first operand is a glob pattern that must keep its literal
# spelling (no unescaping) while still expanding nested $-expansions.
_PATTERN_OPS = _REPLACE_OPS | _STRIP_OPS | _CASE_OPS

_LITERAL_ARG_TYPES = frozenset({NT.WORD, NT.NUMBER, "regex"})


def _lookup_var(var: str, session: Session,
                call_stack: CallStack | None) -> str:
    env = session.env
    last_exit_code = session.last_exit_code
    positional = getattr(session, "positional_args", None)
    if var in ("@", "*"):
        if call_stack and call_stack.get_all_positional():
            return " ".join(call_stack.get_all_positional())
        if positional:
            return " ".join(positional)
        return ""
    if var == "#":
        if call_stack and call_stack.get_all_positional():
            return str(call_stack.get_positional_count())
        if positional:
            return str(len(positional))
        return "0"
    if var == "?":
        return str(last_exit_code)
    if var == "$":
        return str(os.getpid())
    if var == "!":
        # Deliberate divergence from bash: jobs are identified by job
        # table id, not OS pid, so $! yields the id `wait`/`kill` accept.
        last_job = session.last_bg_job_id
        return str(last_job) if last_job is not None else ""
    if var.isdigit():
        idx = int(var)
        if idx == 0:
            return "mirage"
        if call_stack and call_stack.get_positional(idx):
            return call_stack.get_positional(idx)
        if positional and 0 < idx <= len(positional):
            return positional[idx - 1]
        return ""
    if call_stack:
        local_val = call_stack.get_local(var)
        if local_val is not None:
            return local_val
    arrays = getattr(session, "arrays", None)
    if arrays and var in arrays:
        arr = arrays[var]
        return arr[0] if arr else ""
    if var == "PWD":
        return session.cwd
    if var == "HOME":
        return home_dir(session) or ""
    return env.get(var, "")


@dataclass(frozen=True, slots=True)
class _BraceParse:
    """Structural pieces of one ``${...}`` expansion."""
    var_name: str | None
    subscript: str | None
    length_op: bool
    indirect_op: bool
    op: str | None
    groups: tuple[tuple[tree_sitter.Node, ...], ...]


def _group_separator(op: str | None) -> str | None:
    if op in _REPLACE_OPS:
        return "/"
    if op == ":":
        return ":"
    return None


def _parse_braces(node: tree_sitter.Node) -> _BraceParse:
    var_name = None
    subscript = None
    length_op = False
    indirect_op = False
    op = None
    groups: list[list[tree_sitter.Node]] = []
    seen_var = False
    for c in node.children:
        if c.type == "${" or c.type == "}":
            continue
        if c.type == "#" and not seen_var:
            length_op = True
            continue
        if c.type == "!" and not seen_var:
            indirect_op = True
            continue
        if c.type in (NT.VARIABLE_NAME,
                      NT.SPECIAL_VARIABLE_NAME) and not seen_var:
            var_name = get_text(c)
            seen_var = True
            continue
        if c.type == "subscript" and not seen_var:
            for sc in c.named_children:
                if sc.type == NT.VARIABLE_NAME and var_name is None:
                    var_name = get_text(sc)
                elif subscript is None:
                    subscript = get_text(sc)
            seen_var = True
            continue
        if c.type in _PARAM_OPS and op is None:
            op = get_text(c)
            groups.append([])
            continue
        if op is not None and not c.is_named and c.type == _group_separator(
                op):
            groups.append([])
            continue
        if op is not None:
            groups[-1].append(c)
    return _BraceParse(var_name=var_name,
                       subscript=subscript,
                       length_op=length_op,
                       indirect_op=indirect_op,
                       op=op,
                       groups=tuple(tuple(g) for g in groups))


def _expand_dollar_refs(text: str, session: Session,
                        call_stack: CallStack | None) -> str:
    """Expand ``$name``/``${name}`` references embedded in a pattern.

    Pattern operands (``${f%$ext}``) arrive as opaque ``regex`` nodes
    whose ``$``-references have no child nodes; resolve them textually
    while keeping every other character (glob syntax) literal.

    Args:
        text (str): the raw pattern text.
        session (Session): shell session for name resolution.
        call_stack (CallStack | None): function-call scope, if any.
    """
    if "$" not in text:
        return text
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch != "$" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        j = i + 1
        braced = text[j] == "{"
        if braced:
            j += 1
        start = j
        while j < n and (text[j].isalnum() or text[j] == "_"):
            j += 1
        name = text[start:j]
        if not name or (braced and (j >= n or text[j] != "}")):
            out.append(ch)
            i += 1
            continue
        if braced:
            j += 1
        out.append(_lookup_var(name, session, call_stack))
        i = j
    return "".join(out)


async def _expand_operand(node: tree_sitter.Node, expand_child: ExpandChild,
                          pattern_mode: bool, session: Session,
                          call_stack: CallStack | None) -> str:
    if node.type == NT.CONCATENATION:
        return await _expand_group(tuple(node.children), expand_child,
                                   pattern_mode, session, call_stack)
    if pattern_mode and node.type in _LITERAL_ARG_TYPES:
        return _expand_dollar_refs(get_text(node), session, call_stack)
    return await expand_child(node)


async def _expand_group(nodes: tuple[tree_sitter.Node, ...],
                        expand_child: ExpandChild, pattern_mode: bool,
                        session: Session, call_stack: CallStack | None) -> str:
    """Expand adjacent operand nodes, preserving inter-node whitespace.

    ``${x:?custom msg}`` carries its message as sibling nodes whose gap
    (the space) exists only in the source bytes; stitch gaps back from
    byte offsets so multi-word operands round-trip.
    """
    pieces: list[str] = []
    prev = None
    for c in nodes:
        if prev is not None and c.start_byte > prev.end_byte:
            gap = c.start_byte - prev.end_byte
            pieces.append(" " * gap)
        pieces.append(await _expand_operand(c, expand_child, pattern_mode,
                                            session, call_stack))
        prev = c
    return "".join(pieces)


def _glob_strip(value: str, pattern: str, greedy: bool, prefix: bool) -> str:
    if not pattern:
        return value
    if prefix:
        candidates = [
            i for i in range(len(value) + 1) if fnmatch(value[:i], pattern)
        ]
        if not candidates:
            return value
        i = max(candidates) if greedy else min(candidates)
        return value[i:]
    candidates = [
        i for i in range(len(value) + 1) if fnmatch(value[i:], pattern)
    ]
    if not candidates:
        return value
    i = min(candidates) if greedy else max(candidates)
    return value[:i]


def _glob_replace(value: str, pattern: str, replacement: str,
                  replace_all: bool, anchor: str | None) -> str:
    """Bash ``${var/pat/rep}``: pattern is a glob, longest match wins.

    Args:
        value (str): the variable's value.
        pattern (str): glob pattern (may be empty: value unchanged).
        replacement (str): replacement text.
        replace_all (bool): ``//`` — replace every match.
        anchor (str | None): ``#`` (prefix) or ``%`` (suffix) or None.
    """
    if not pattern:
        return value
    if anchor == "#":
        for j in range(len(value), -1, -1):
            if fnmatch(value[:j], pattern):
                return replacement + value[j:]
        return value
    if anchor == "%":
        for i in range(len(value) + 1):
            if fnmatch(value[i:], pattern):
                return value[:i] + replacement
        return value
    if not value:
        return replacement if fnmatch("", pattern) else value
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        match_end = -1
        for j in range(n, i - 1, -1):
            if fnmatch(value[i:j], pattern):
                match_end = j
                break
        if match_end <= i:
            # No match here (or an empty one, which bash skips over).
            out.append(value[i])
            i += 1
            continue
        out.append(replacement)
        i = match_end
        if not replace_all:
            out.append(value[i:])
            return "".join(out)
    return "".join(out)


def _case_mod(op: str, val: str, pattern: str) -> str:
    if not val:
        return val
    chars = list(val)
    scope = range(len(chars)) if op in ("^^", ",,") else range(1)
    for i in scope:
        ch = chars[i]
        if pattern and not fnmatch(ch, pattern):
            continue
        chars[i] = ch.upper() if op in ("^", "^^") else ch.lower()
    return "".join(chars)


def _arith_int(text: str, env: dict[str, str]) -> int | None:
    """Resolve an arithmetic-context operand (offsets, subscripts).

    bash evaluates substring offsets and array subscripts as
    arithmetic (``${v:1+1}``, ``${a[i+1]}``).

    Args:
        text (str): the raw operand text.
        env (dict[str, str]): session environment for name resolution.
    """
    try:
        return int(text.strip())
    except ValueError:
        pass
    try:
        value, _ = evaluate_arith(text, env)
    except ArithError:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _substring(val: str, groups: list[str], env: dict[str, str]) -> str:
    if not groups:
        return val
    offset = _arith_int(groups[0], env)
    if offset is None:
        return val
    length = None
    if len(groups) > 1:
        length = _arith_int(groups[1], env)
        if length is None:
            return val
    if offset < 0:
        offset = max(0, len(val) + offset)
    if length is None:
        return val[offset:]
    if length < 0:
        return val[offset:max(offset, len(val) + length)]
    return val[offset:offset + length]


def _array_index(idx_text: str, env: dict[str, str]) -> int:
    """Resolve a numeric or arithmetic array subscript.

    bash evaluates subscripts in arithmetic context (``${a[i+1]}``);
    unresolvable expressions index element 0, mirroring bash's
    unset-name-is-zero arithmetic rule.

    Args:
        idx_text (str): the raw subscript text.
        env (dict[str, str]): session environment for name resolution.
    """
    resolved = _arith_int(idx_text, env)
    return resolved if resolved is not None else 0


def _value_op(op: str, val: str, groups: list[str], env: dict[str,
                                                              str]) -> str:
    if op in _STRIP_OPS:
        pattern = groups[0] if groups else ""
        return _glob_strip(val, pattern, op in ("##", "%%"), op in ("#", "##"))
    if op in _REPLACE_OPS:
        pattern = groups[0] if groups else ""
        replacement = groups[1] if len(groups) > 1 else ""
        anchor = op[1] if len(op) > 1 and op[1] in "#%" else None
        return _glob_replace(val, pattern, replacement, op == "//", anchor)
    if op in _CASE_OPS:
        return _case_mod(op, val, groups[0] if groups else "")
    if op == ":":
        return _substring(val, groups, env)
    return val


async def expand_braces(node: tree_sitter.Node, session: Session,
                        call_stack: CallStack | None,
                        expand_child: ExpandChild) -> str:
    """Expand ${VAR}, ${VAR<op>...}, ${a[i]}, ${#a[@]}, etc.

    Args:
        node (tree_sitter.Node): the ``expansion`` tree-sitter node.
        session (Session): shell session (env, arrays, positionals).
        call_stack (CallStack | None): function-call scope, if any.
        expand_child (ExpandChild): callback that expands a nested node
            (dependency-injected to avoid a cycle with ``expand_node``).
    """
    p = _parse_braces(node)
    env = session.env
    arrays = getattr(session, "arrays", {})

    groups: list[str] = []
    for gi, group in enumerate(p.groups):
        pattern_mode = gi == 0 and p.op in _PATTERN_OPS
        groups.append(await _expand_group(group, expand_child, pattern_mode,
                                          session, call_stack))

    val = ""
    var_in_env = False
    if p.subscript is not None and p.var_name is not None:
        arr = arrays.get(p.var_name)
        if arr is None:
            scalar = env.get(p.var_name, "")
            arr = [scalar] if scalar else []
        var_in_env = p.var_name in arrays or p.var_name in env
        if p.subscript in ("@", "*"):
            if p.indirect_op:
                return " ".join(str(i) for i in range(len(arr)))
            if p.length_op:
                return str(len(arr))
            if p.op == ":":
                sliced = _slice_array(arr, groups, env)
                return " ".join(sliced)
            if p.op in _STRIP_OPS | _REPLACE_OPS | _CASE_OPS:
                return " ".join(_value_op(p.op, el, groups, env) for el in arr)
            val = " ".join(arr)
        else:
            idx = _array_index(p.subscript, env)
            if idx < 0:
                idx += len(arr)
            if 0 <= idx < len(arr):
                val = arr[idx]
                var_in_env = True
            else:
                val = ""
                var_in_env = False
    elif p.var_name:
        if call_stack:
            local_val = call_stack.get_local(p.var_name)
            if local_val is not None:
                val = local_val
                var_in_env = True
        if not var_in_env and p.var_name in arrays:
            arr = arrays[p.var_name]
            val = arr[0] if arr else ""
            var_in_env = True
        if not var_in_env and p.var_name in env:
            val = env[p.var_name]
            var_in_env = True
        if not var_in_env:
            # Specials, positionals, PWD/HOME fall back to the shared
            # lookup; set-ness follows value presence.
            val = _lookup_var(p.var_name, session, call_stack)
            var_in_env = val != ""

    if p.indirect_op:
        return _lookup_var(val, session, call_stack) if val else ""
    if p.length_op:
        return str(len(val))
    if p.op is None:
        return val
    if p.op in ("?", ":?"):
        triggered = (not var_in_env) if p.op == "?" else (not val)
        if not triggered:
            return val
        if groups and groups[0]:
            message = groups[0]
        elif p.op == "?":
            message = "parameter not set"
        else:
            message = "parameter null or not set"
        # GNU: fatal at top level with status 127; a containing
        # subshell/pipeline segment reports 1.
        raise ExitSignal(127,
                         stderr=f"bash: {p.var_name}: {message}\n".encode(),
                         contained_code=1)
    if p.op in ("=", ":="):
        triggered = (not var_in_env) if p.op == "=" else (not val)
        if not triggered:
            return val
        default = groups[0] if groups else ""
        if p.var_name is not None:
            if (call_stack is not None
                    and call_stack.get_local(p.var_name) is not None):
                call_stack.set_local(p.var_name, default)
            else:
                env[p.var_name] = default
        return default
    if p.op == ":-":
        return val if val else (groups[0] if groups else "")
    if p.op == "-":
        if var_in_env:
            return val
        return groups[0] if groups else ""
    if p.op == ":+":
        return (groups[0] if groups else "") if val else ""
    if p.op == "+":
        return (groups[0] if groups else "") if var_in_env else ""
    return _value_op(p.op, val, groups, env)


def _slice_array(arr: list[str], groups: list[str],
                 env: dict[str, str]) -> list[str]:
    if not groups:
        return arr
    offset = _arith_int(groups[0], env)
    if offset is None:
        return arr
    length = None
    if len(groups) > 1:
        length = _arith_int(groups[1], env)
        if length is None:
            return arr
    if offset < 0:
        offset = max(0, len(arr) + offset)
    if length is None:
        return arr[offset:]
    if length < 0:
        return arr[offset:max(offset, len(arr) + length)]
    return arr[offset:offset + length]
