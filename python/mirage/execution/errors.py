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


class WorkspaceHeldError(RuntimeError):
    """A line or job refused because another daemon holds the
    workspace's lease and runs its processes.

    For now one daemon runs a workspace at a time. Any other one lists,
    waits on and signals what runs there through the store; forwarding
    its lines to the holder comes later.

    Args:
        workspace_id (str): the workspace.
        holder (str): the id of the daemon holding its lease.
    """

    def __init__(self, workspace_id: str, holder: str) -> None:
        super().__init__(
            f"workspace {workspace_id!r} runs on daemon {holder!r}; "
            "only that daemon runs its lines"
        )
        self.workspace_id = workspace_id
        self.holder = holder
