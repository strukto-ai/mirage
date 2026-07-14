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

from agents.apply_diff import apply_diff
from agents.editor import (ApplyPatchEditor, ApplyPatchOperation,
                           ApplyPatchResult)

from mirage.workspace.workspace import Workspace


class MirageEditor(ApplyPatchEditor):
    """ApplyPatchEditor backed by a Mirage Workspace.

    Args:
        workspace (Workspace): The workspace for file operations.
    """

    def __init__(self, workspace: Workspace) -> None:
        self._ws = workspace

    async def create_file(self, op: ApplyPatchOperation) -> ApplyPatchResult:
        ops = self._ws.ops
        parent = "/".join(op.path.rstrip("/").split("/")[:-1]) or "/"
        try:
            await ops.mkdir(parent)
        except (FileExistsError, ValueError):
            # mkdir -p semantics: an existing parent is success
            pass
        content = apply_diff("", op.diff or "", mode="create")
        await ops.write(op.path, content.encode("utf-8"))
        return ApplyPatchResult(status="completed")

    async def update_file(self, op: ApplyPatchOperation) -> ApplyPatchResult:
        ops = self._ws.ops
        try:
            data = await ops.read(op.path)
        except (FileNotFoundError, ValueError):
            return ApplyPatchResult(status="failed",
                                    output=f"File not found: {op.path}")
        current = data.decode("utf-8", errors="replace")
        new_content = apply_diff(current, op.diff or "")
        await ops.write(op.path, new_content.encode("utf-8"))
        return ApplyPatchResult(status="completed")

    async def delete_file(self, op: ApplyPatchOperation) -> ApplyPatchResult:
        ops = self._ws.ops
        try:
            await ops.unlink(op.path)
        except (FileNotFoundError, ValueError):
            return ApplyPatchResult(status="failed",
                                    output=f"File not found: {op.path}")
        return ApplyPatchResult(status="completed")
