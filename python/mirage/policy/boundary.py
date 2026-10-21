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

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from mirage.context import Caller
from mirage.policy.policies import Policies, post_vfs_gate, pre_vfs_gate
from mirage.types import MountMode, PathSpec
from mirage.vfs.types import VfsCall

if TYPE_CHECKING:
    from mirage.policy.decisions import Decisions


@dataclass(frozen=True, slots=True)
class Boundary:
    """The POSIX policy boundary for dispatched filesystem operations.

    Args:
        policies (Policies): ordered builtin and user policies.
        prefix (str): owning mount prefix.
        mode (MountMode | None): configured authorization ceiling.
        decisions (Decisions | None): the approval ledger a path rule
            that asks is put to where no line is running.
        caller (Caller): who makes the operation; its session's grants
            govern it.
    """

    policies: Policies
    prefix: str = ""
    mode: MountMode | None = None
    decisions: "Decisions | None" = None
    caller: Caller = Caller()

    @property
    def session_id(self) -> str:
        """The id of the session whose grants govern the operation,
        empty for the unbound host view."""
        session = self.caller.session
        return session.session_id if session is not None else ""

    async def admit(
        self,
        call: VfsCall,
        path: PathSpec,
        write: bool,
        *,
        final: bool = True,
    ) -> None:
        await pre_vfs_gate(
            self.policies,
            call,
            path,
            write,
            self.prefix,
            self.session_id,
            mode=self.mode,
            decisions=self.decisions,
            final=final,
            caller=self.caller,
        )

    async def complete(
        self, call: VfsCall, path: PathSpec, write: bool, result: Any
    ) -> Any:
        """Fire post_vfs on a finished call and hand its result back
        whole.

        Args:
            call (VfsCall): what the mount's VFS declares for the call.
            path (PathSpec): the path the call named.
            write (bool): whether the call writes.
            result (Any): what the call returned.
        """
        await post_vfs_gate(
            self.policies,
            call,
            path,
            write,
            self.prefix,
            result,
            self.session_id,
            mode=self.mode,
            decisions=self.decisions,
            caller=self.caller,
        )
        return result
