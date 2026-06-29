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

import fnmatch

from mirage.shell.call_stack import CallStack
from mirage.shell.types import NodeType as NT
from mirage.workspace.session import Session
from mirage.workspace.session.shell_dirs import home_dir

_PARAM_OPS = frozenset({
    ":-", "-", ":+", "+", ":?", "?", ":=", "=", "#", "##", "%", "%%", "/",
    "//", ":", "^", "^^", ",", ",,", "!"
})


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
    if var == "PWD":
        return session.cwd
    if var == "HOME":
        return home_dir(session) or ""
    return env.get(var, "")


def _glob_strip(value: str, pattern: str, greedy: bool, prefix: bool) -> str:
    if not pattern:
        return value
    if prefix:
        candidates = [
            i for i in range(len(value) + 1)
            if fnmatch.fnmatchcase(value[:i], pattern)
        ]
        if not candidates:
            return value
        i = max(candidates) if greedy else min(candidates)
        return value[i:]
    candidates = [
        i for i in range(len(value) + 1)
        if fnmatch.fnmatchcase(value[i:], pattern)
    ]
    if not candidates:
        return value
    i = min(candidates) if greedy else max(candidates)
    return value[:i]


def _apply_op(op: str, val: str, var_in_env: bool, args: list[str]) -> str:
    if op == ":-":
        return val if val else (args[0] if args else "")
    if op == "-":
        if var_in_env:
            return val
        return args[0] if args else ""
    if op == ":+":
        return (args[0] if args else "") if val else ""
    if op == "+":
        return (args[0] if args else "") if var_in_env else ""
    if op == "#":
        return _glob_strip(val, args[0] if args else "", False, True)
    if op == "##":
        return _glob_strip(val, args[0] if args else "", True, True)
    if op == "%":
        return _glob_strip(val, args[0] if args else "", False, False)
    if op == "%%":
        return _glob_strip(val, args[0] if args else "", True, False)
    if op == "/":
        if not args:
            return val
        replacement = args[1] if len(args) > 1 else ""
        return val.replace(args[0], replacement, 1)
    if op == "//":
        if not args:
            return val
        replacement = args[1] if len(args) > 1 else ""
        return val.replace(args[0], replacement)
    if op == "^^":
        return val.upper()
    if op == ",,":
        return val.lower()
    if op == "^":
        return val[:1].upper() + val[1:] if val else val
    if op == ",":
        return val[:1].lower() + val[1:] if val else val
    if op == ":" and args:
        try:
            offset = int(args[0])
            length = int(args[1]) if len(args) > 1 else None
        except ValueError:
            return val
        if offset < 0:
            offset = max(0, len(val) + offset)
        if length is None:
            return val[offset:]
        if length < 0:
            return val[offset:max(offset, len(val) + length)]
        return val[offset:offset + length]
    return val


def _expand_braces(
    node,
    env: dict,
    arrays: dict,
    call_stack: CallStack | None,
) -> str:
    """Expand ${VAR}, ${VAR<op>...}, ${a[i]}, ${#a[@]}, etc."""
    var_name = None
    subscript_node = None
    length_op = False
    indirect_op = False
    op = None
    args: list[str] = []
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
        if c.type == NT.VARIABLE_NAME:
            var_name = c.text.decode()
            seen_var = True
            continue
        if c.type == "subscript":
            subscript_node = c
            for sc in c.named_children:
                if sc.type == NT.VARIABLE_NAME:
                    var_name = sc.text.decode()
                    break
            seen_var = True
            continue
        if c.type in _PARAM_OPS and op is None:
            op = c.text.decode()
            continue
        if c.type in (NT.WORD, NT.STRING, NT.RAW_STRING, NT.STRING_CONTENT,
                      NT.NUMBER, "regex"):
            args.append(c.text.decode())

    val = ""
    var_in_env = False
    if subscript_node is not None and var_name is not None:
        idx_text = ""
        for sc in subscript_node.named_children:
            if sc.type == NT.VARIABLE_NAME:
                continue
            idx_text = sc.text.decode()
            break
        arr = arrays.get(var_name)
        if arr is None:
            scalar = env.get(var_name, "")
            arr = [scalar] if scalar else []
        var_in_env = var_name in arrays or var_name in env
        if idx_text in ("@", "*"):
            if length_op:
                return str(len(arr))
            val = " ".join(arr)
        else:
            try:
                i = int(idx_text)
                val = arr[i] if 0 <= i < len(arr) else ""
            except ValueError:
                val = ""
    elif var_name:
        if call_stack:
            local_val = call_stack.get_local(var_name)
            if local_val is not None:
                val = local_val
                var_in_env = True
        if not var_in_env:
            var_in_env = var_name in env
            val = env.get(var_name, "")

    if indirect_op:
        return env.get(val, "") if val else ""
    if length_op:
        return str(len(val))
    if op is None:
        return val
    return _apply_op(op, val, var_in_env, args)
