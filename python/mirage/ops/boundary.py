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

from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.context.session_context import get_admission
from mirage.policy.constants import METADATA_OPS
from mirage.policy.policies import Policies, post_vfs_gate, pre_vfs_gate
from mirage.types import MountMode, PathSpec

if TYPE_CHECKING:
    from mirage.policy.decisions import Decisions


@dataclass(frozen=True, slots=True)
class OpBoundary:
    """The POSIX policy boundary for dispatched filesystem operations.

    Args:
        policies (Policies): ordered builtin and user policies.
        prefix (str): owning mount prefix.
        mode (MountMode | None): configured authorization ceiling.
        session_id (str): session whose grants govern this operation.
        decisions (Decisions | None): the approval ledger a path rule
            that asks is put to where no line is running.
    """

    policies: Policies
    prefix: str = ""
    mode: MountMode | None = None
    session_id: str = ""
    decisions: "Decisions | None" = None

    @staticmethod
    def check(op: str, *paths: PathSpec | None) -> None:
        """Check each spelling once against the active command's rules.

        Args:
            op (str): operation name; metadata retains its exemption.
            *paths (PathSpec | None): typed, walked and followed endpoints.
        """
        gate = get_admission()
        if gate is not None and op not in METADATA_OPS:
            for virtual in dict.fromkeys(
                p.virtual for p in paths if isinstance(p, PathSpec)
            ):
                gate.check(virtual)

    async def admit(
        self,
        op: str,
        path: PathSpec,
        write: bool,
        *,
        create: bool = False,
        subtree: bool = False,
        check_hidden: bool = True,
        final: bool = True,
    ) -> None:
        await pre_vfs_gate(
            self.policies,
            op,
            path,
            write,
            self.prefix,
            self.session_id,
            mode=self.mode,
            create=create,
            subtree=subtree,
            check_hidden=check_hidden,
            decisions=self.decisions,
            final=final,
        )

    async def complete(
        self, op: str, path: PathSpec, write: bool, result: Any
    ) -> Any:
        bound = await post_vfs_gate(
            self.policies, op, path, write, self.prefix, result
        )
        return await apply_op_limit(result, bound)
