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

from collections.abc import Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def _eval_test(dispatch: Callable, argv: list) -> bool:
    if not argv:
        return False
    first = _scope_path(argv[0])
    if first == "!" and len(argv) > 1:
        return not await _eval_test(dispatch, argv[1:])
    if len(argv) == 1:
        return bool(first)
    if len(argv) == 2:
        op = _scope_path(argv[0])
        val = argv[1]
        if op == "-z":
            return _scope_path(val) == ""
        if op == "-n":
            return _scope_path(val) != ""
        if op == "-f":
            scope = val if isinstance(val, PathSpec) else _to_scope(
                _scope_path(val))
            try:
                await dispatch("stat", scope)
                return True
            except (FileNotFoundError, ValueError):
                return False
        if op == "-d":
            scope = val if isinstance(val, PathSpec) else PathSpec(
                virtual=_scope_path(val),
                directory=_scope_path(val),
                resource_path="",
                resolved=False)
            try:
                await dispatch("readdir", scope)
                return True
            except (FileNotFoundError, ValueError, NotADirectoryError):
                return False
    if len(argv) == 3:
        left = _scope_path(argv[0])
        op = _scope_path(argv[1])
        right = _scope_path(argv[2])
        if op == "=" or op == "==":
            return left == right
        if op == "!=":
            return left != right
        try:
            li, ri = int(left), int(right)
        except (ValueError, TypeError):
            return False
        if op == "-eq":
            return li == ri
        if op == "-ne":
            return li != ri
        if op == "-lt":
            return li < ri
        if op == "-le":
            return li <= ri
        if op == "-gt":
            return li > ri
        if op == "-ge":
            return li >= ri
    return False


async def handle_test(
    dispatch: Callable,
    argv: list,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    result = await _eval_test(dispatch, argv)
    code = 0 if result else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="test",
                                                         exit_code=code)
