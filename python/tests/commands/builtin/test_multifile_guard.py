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

import pytest

BUILTIN = pathlib.Path(
    __file__).resolve().parents[3] / "mirage" / "commands" / "builtin"

GUARDED_COMMANDS = ("cat", "head", "tail", "wc", "du", "file", "nl", "md5")

# Backends whose command genuinely operates on a single resource and rejects
# or has no multi-file semantics. Each entry needs a one-line reason so the
# allowlist stays honest. Keyed by (command, backend).
ALLOWLIST = {
    ("wc", "mongodb"): "counts documents of one collection via count API",
}


def _command_funcs(tree: ast.Module) -> list[ast.AsyncFunctionDef]:
    funcs = []
    for node in tree.body:
        if not isinstance(node, ast.AsyncFunctionDef):
            continue
        for dec in node.decorator_list:
            target = dec.func if isinstance(dec, ast.Call) else dec
            name = getattr(target, "id", getattr(target, "attr", None))
            if name == "command":
                funcs.append(node)
    return funcs


def _calls_resolve_glob(func: ast.AST) -> bool:
    for node in ast.walk(func):
        if isinstance(node, ast.Call):
            target = node.func
            name = getattr(target, "id", getattr(target, "attr", None))
            if name == "resolve_glob":
                return True
    return False


def _indexes_first(func: ast.AST) -> bool:
    for node in ast.walk(func):
        if (isinstance(node, ast.Subscript)
                and isinstance(node.value, ast.Name)
                and node.value.id in ("paths", "resolved")):
            idx = node.slice
            if isinstance(idx, ast.Constant) and idx.value == 0:
                return True
    return False


def _loops_paths(func: ast.AST) -> bool:
    for node in ast.walk(func):
        if isinstance(node, (ast.For, ast.AsyncFor)) and isinstance(
                node.iter, ast.Name) and node.iter.id in ("paths", "resolved"):
            return True
        # comprehension form: {... for p in paths}
        for comp in ast.walk(node) if isinstance(node,
                                                 (ast.DictComp, ast.ListComp,
                                                  ast.SetComp,
                                                  ast.GeneratorExp)) else []:
            if isinstance(comp, ast.comprehension) and isinstance(
                    comp.iter,
                    ast.Name) and comp.iter.id in ("paths", "resolved"):
                return True
    return False


_MULTI_HELPERS = ("format_multi", "generic_grep", "generic_rg", "grep", "rg",
                  "generic_du", "generic_file", "file_cmd", "du_multi",
                  "generic_nl", "generic_md5")


def _passes_full_list(func: ast.AST) -> bool:
    """Heuristic: the resolved list is handed to a *_multi / generic helper.

    Covers backends that delegate multi-file handling to a generic routine
    (head_multi, tail_multi, format_multi, du_multi, file_cmd, generic_grep,
    generic_rg) by passing the whole ``paths``/``resolved`` list as the first
    argument.
    """
    for node in ast.walk(func):
        if not isinstance(node, ast.Call):
            continue
        target = node.func
        name = getattr(target, "id", getattr(target, "attr", "")) or ""
        if name.endswith("_multi") or name in _MULTI_HELPERS:
            for arg in node.args:
                if isinstance(arg,
                              ast.Name) and arg.id in ("paths", "resolved"):
                    return True
    return False


def _iter_command_files():
    for path in sorted(BUILTIN.glob("*/*.py")):
        cmd = path.stem
        if cmd not in GUARDED_COMMANDS:
            continue
        backend = path.parent.name
        yield cmd, backend, path


@pytest.mark.parametrize(
    "cmd,backend,path",
    [
        pytest.param(c, b, p, id=f"{c}:{b}")
        for c, b, p in _iter_command_files()
    ],
)
def test_command_handles_multiple_files(cmd, backend, path):
    if (cmd, backend) in ALLOWLIST:
        pytest.skip(ALLOWLIST[(cmd, backend)])
    tree = ast.parse(path.read_text())
    for func in _command_funcs(tree):
        if not _calls_resolve_glob(func):
            continue
        if _loops_paths(func) or _passes_full_list(func):
            continue
        if _indexes_first(func):
            pytest.fail(
                f"{cmd}/{backend}: command resolves a glob but indexes "
                f"paths[0]/resolved[0] without looping all paths. This drops "
                f"every file after the first (the multi-file bug). Loop all "
                f"paths or delegate to a *_multi helper. If this backend is "
                f"genuinely single-resource, add it to ALLOWLIST with a "
                f"reason.")
