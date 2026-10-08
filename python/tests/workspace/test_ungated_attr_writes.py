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

import ast
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[2] / "mirage"

# `set_attr` is the *ungated* attribute door: it writes the record and
# asks no policy. That is correct only where this operand's own path
# already cleared `pre_session`, which is a per-call-site fact and not a
# property of the function it sits in. Reading a nearby `view.set` and
# assuming it covers the name at hand is how three separate bugs shipped:
# `readonly NAME` froze a refused name, `declare -x NAME` exported a
# host-seeded credential, and `SECRET=x cmd` handed one to the command.
#
# So every call site is written down here with the reason it is allowed.
# A new one fails this test until someone states which gated write covers
# it, or routes it through `view.mark` instead.
_DECLARE = "mirage/workspace/executor/builtins/declare"

ALLOWED = {
    (
        f"{_DECLARE}/declare.py",
        "mark_written",
    ): "only when the name resolves where it did before the caller's "
    "`view.set` gated it; a write that re-aimed a `declare -n` "
    "reference marks its new target through `view.mark`",
    (
        "mirage/workspace/node/declaration.py",
        "_stamp_export",
    ): "the `covered` branch only, which is the names that carried a "
    "value or a staged array literal; a bare name has no gated write "
    "to ride on and goes through `view.mark`",
    (
        "mirage/workspace/node/command_dispatch.py",
        "execute_command",
    ): "the prefix-assignment loop calls `pre_session_gate` explicitly "
    "before seeding, since `seed_var` is the ungated door",
    (
        "mirage/workspace/node/command_dispatch.py",
        "seed_prefix",
    ): "execute_command's seeding, run once the command's words are "
    "expanded, of values its `pre_session_gate` loop already admitted",
    (
        "mirage/workspace/session/shell_dirs.py",
        "change_dir",
    ): "the shell's own bookkeeping for the two fixed names PWD and "
    "OLDPWD as part of a cd the router already authorized, not a "
    "name the agent chose; an agent-typed `PWD=x` is an ordinary "
    "assignment and goes through the door",
    (
        "mirage/workspace/session/state.py",
        "mark_var",
    ): "this is the gated door itself: the write lands after "
    "`ensure_var_visible` and `pre_session_gate`",
}


def _call_sites() -> set[tuple[str, str]]:
    """Every `set_attr(...)` call, as (module path, enclosing function).

    Returns:
        set[tuple[str, str]]: repo-relative path and function name.
    """
    found: set[tuple[str, str]] = set()
    for path in sorted(SRC.rglob("*.py")):
        text = path.read_text()
        if "set_attr(" not in text:
            continue
        rel = path.relative_to(SRC.parent).as_posix()
        for node in ast.walk(ast.parse(text)):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for sub in ast.walk(node):
                if (
                    isinstance(sub, ast.Call)
                    and isinstance(sub.func, ast.Name)
                    and sub.func.id == "set_attr"
                ):
                    found.add((rel, node.name))
    return found


def test_every_ungated_attribute_write_is_accounted_for():
    sites = _call_sites()
    new = sites - set(ALLOWED)
    assert not new, (
        "ungated set_attr call site with no stated reason: "
        f"{sorted(new)}. Either name the gated write that covers this "
        "operand and add it to ALLOWED, or route the mark through "
        "`view.mark` so `pre_session` sees it."
    )


def test_no_stale_entries():
    stale = set(ALLOWED) - _call_sites()
    assert not stale, (
        f"ALLOWED names a call site that is gone: {sorted(stale)}"
    )
