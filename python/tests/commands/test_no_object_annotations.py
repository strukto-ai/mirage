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
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[2] / "mirage"

# Every place `object` is still the honest annotation, each because the
# signature is not ours to choose. The first four are Python protocol
# methods, whose parameters the language types as object so that a
# membership or attribute test on an unrelated value stays legal. The
# fifth is the guard whose entire job is to catch a value the annotations
# already claim cannot arrive (a plain string where a PolicyFn belongs),
# so narrowing it would make its own call sites type errors.
ALLOWED = {
    # Overrides an external base class that declares `dict[str, object]`;
    # narrowing it here would break Liskov and mypy says so.
    ("agents/openai_agents/sandbox.py", "deserialize_session_state"),
    ("io/types.py", "__setattr__"),
    ("commands/cli/builtin/git/objects.py", "__contains__"),
    ("resource/dev/dev.py", "__contains__"),
    ("resource/dev/dev.py", "pop"),
    ("workspace/workspace/guard.py", "reject_config_script"),
}


def _mentions_object(node: ast.AST | None) -> bool:
    if node is None:
        return False
    return any(
        isinstance(child, ast.Name) and child.id == "object"
        for child in ast.walk(node))


def test_annotations_name_a_real_type():
    """No annotation is `object`; the value's own type has a name.

    `object` reads as "we did not decide": it accepts bytes where JSON
    was meant and a PathSpec where a flag value was meant, and every use
    site pays for that with an isinstance chain back to the set the
    author had in mind. The three sets that kept showing up have names --
    `FlagValue` for a parsed flag, `JsonValue` for a decoded payload,
    `PathSpec` for a path -- and `FlagValue` is also what the TypeScript
    side has always called it.
    """
    offenders = []
    for path in sorted(SOURCE.rglob("*.py")):
        rel = path.relative_to(SOURCE).as_posix()
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if (rel, node.name) in ALLOWED:
                continue
            args = node.args
            annotated = [
                *args.posonlyargs, *args.args, *args.kwonlyargs, args.vararg,
                args.kwarg
            ]
            named = [arg.annotation
                     for arg in annotated if arg is not None] + [node.returns]
            if any(_mentions_object(item) for item in named):
                offenders.append(f"{rel}: {node.name}")
    assert not offenders, (
        "annotate the real type (FlagValue for a parsed flag, JsonValue "
        "for a decoded payload, PathSpec for a path), not `object`:\n" +
        "\n".join(offenders))
