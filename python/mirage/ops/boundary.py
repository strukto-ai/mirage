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
from typing import Any

from mirage.commands.builtin.utils.limit import apply_op_limit
from mirage.policy.policies import Policies, post_ops_gate, pre_ops_gate
from mirage.types import MountMode, PathSpec


@dataclass(frozen=True, slots=True)
class OpBoundary:
    """The POSIX policy boundary for dispatched filesystem operations.

    Args:
        policies (Policies): ordered builtin and user policies.
        prefix (str): owning mount prefix.
        mode (MountMode | None): configured authorization ceiling.
        session_id (str): session whose grants govern this operation.
    """

    policies: Policies
    prefix: str = ""
    mode: MountMode | None = None
    session_id: str = ""

    async def admit(
        self,
        op: str,
        path: PathSpec,
        write: bool,
        *,
        create: bool = False,
        subtree: bool = False,
        check_hidden: bool = True,
    ) -> None:
        await pre_ops_gate(
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
        )

    async def complete(
        self, op: str, path: PathSpec, write: bool, result: Any
    ) -> Any:
        bound = await post_ops_gate(
            self.policies, op, path, write, self.prefix, result
        )
        return await apply_op_limit(result, bound)
