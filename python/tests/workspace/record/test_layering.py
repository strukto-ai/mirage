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

RECORD = pathlib.Path(
    __file__).resolve().parents[3] / "mirage/workspace/record"
# The tiers that persist through the record client. Any of them appearing
# in an import here means the substrate has grown a dependency on one of
# its own consumers.
CONSUMERS = ("mirage.workspace.session", "mirage.workspace.store",
             "mirage.workspace.mount")


def imported_modules(path: pathlib.Path) -> list[str]:
    """Every module name one source file imports.

    Args:
        path (pathlib.Path): the source file to read.
    """
    names: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            names.append(node.module)
    return names


def test_the_record_tier_imports_none_of_its_consumers():
    # Sessions, the namespace node table and workspace metadata are three
    # tables that persist the same way; the client is that substrate and
    # nothing more. It used to live inside the session package, so the
    # other two imported upward into it, and the graph claimed sessions
    # were foundational to namespaces and workspace state.
    offenders: list[str] = []
    for path in sorted(RECORD.glob("*.py")):
        for name in imported_modules(path):
            if name.startswith(CONSUMERS):
                offenders.append(f"{path.name} imports {name}")
    assert not offenders, ("the record tier must not import a tier that "
                           f"persists through it: {offenders}")
