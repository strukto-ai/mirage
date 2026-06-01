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
from mirage.types import FileType, PathSpec
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_cd(
    dispatch: Callable,
    is_mount_root: Callable[[str], bool],
    path: str | PathSpec,
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    raw = _scope_path(path)
    resolved = resolve_path(raw, session.cwd)
    if resolved == "/":
        session.cwd = "/"
        return None, IOResult(), ExecutionNode(command=f"cd {raw}",
                                               exit_code=0)
    scope = _to_scope(resolved)
    s = None
    not_found = False
    try:
        s, _ = await dispatch("stat", scope)
    except FileNotFoundError:
        not_found = True
    except ValueError as exc:
        err = f"cd: {raw}: {exc}\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"cd {raw}",
                                                         exit_code=1,
                                                         stderr=err)
    if s is None or not_found:
        if not is_mount_root(resolved):
            err = (f"cd: {raw}: No such file or "
                   f"directory\n").encode()
            return None, IOResult(exit_code=1, stderr=err), ExecutionNode(
                command=f"cd {raw}", exit_code=1, stderr=err)
    elif s.type != FileType.DIRECTORY:
        err = f"cd: {raw}: Not a directory\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command=f"cd {raw}",
                                                         exit_code=1,
                                                         stderr=err)
    session.cwd = resolved
    return None, IOResult(), ExecutionNode(command=f"cd {raw}", exit_code=0)
