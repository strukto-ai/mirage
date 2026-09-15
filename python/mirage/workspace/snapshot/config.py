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

from mirage.commands.cli.types import CLISpec
from mirage.policy.profile import SessionProfile
from mirage.types import ConsistencyPolicy


@dataclass
class MountArgs:
    """Constructor inputs derived from a state dict.

    Workspace.load uses this to instantiate a fresh Workspace; snapshot
    code never constructs Workspace itself.

    Args:
        mount_args (dict[str, Any]): prefix to (resource, mode).
        consistency (ConsistencyPolicy): the workspace's consistency
            knob, LAZY for a state that predates the key.
        default_session_id (str): the snapshot's default session.
        default_agent_id (str | None): the snapshot's default agent.
        clis (dict | None): installed CLIs, spec and config per name.
        profiles (dict[str, SessionProfile] | None): the named profiles
            the snapshot carried, parsed; None when it carried none.
        profile (str | None): the default profile's name, None for the
            implicit ``default`` or no default at all.
        policies (tuple[str, ...]): the class names of the coded
            policies the source registered beyond the built-ins.
            Informational: code is the loader's to supply, and
            ``Workspace.from_state`` warns about a name it does not
            find registered.
    """
    mount_args: dict[str, Any]
    consistency: ConsistencyPolicy
    default_session_id: str
    default_agent_id: str | None
    clis: dict[str, tuple[str | CLISpec, dict[str, Any] | None]] | None = None
    profiles: dict[str, SessionProfile] | None = None
    profile: str | None = None
    policies: tuple[str, ...] = ()
