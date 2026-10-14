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

from dataclasses import dataclass, field

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.sandbox.constants import MOUNT_TYPES
from mirage.runtime.types import MountType


@dataclass(frozen=True, slots=True)
class SandboxConfig(RuntimeConfig):
    """How to reach the sandbox: the fields every provider has.

    This base carries only what all providers support; each provider
    extends it with its own fields (DockerConfig, DaytonaConfig,
    E2BConfig), so an option a provider cannot honor is simply not a
    field there and fails loud at construction (RuntimeConfig.coerce).
    In yaml this is the runtime entry's ``config`` block, mirroring a
    mount's.

    Args:
        env (dict[str, str]): environment set in the sandbox.
        mount_type (MountType | None): how the sandbox sees the
            workspace: ``ssh`` serves every prefix the session sees from
            the host over SFTP (the image needs sshfs), ``fuse`` leaves
            them to a mirage in the sandbox, ``both`` serves from the
            host what the sandbox does not mount itself. None serves
            nothing.
    """

    env: dict[str, str] = field(default_factory=dict)
    mount_type: MountType | None = None


def check_mount_type(runtime: str, mount_type: str | None) -> None:
    """Fail loud on a ``mount_type`` other than ssh, fuse or both.

    Args:
        runtime (str): the runtime's name, for the message.
        mount_type (str | None): the configured value; None serves
            nothing.
    """
    if mount_type is not None and mount_type not in MOUNT_TYPES:
        raise ValueError(
            f"{runtime} mount_type must be one of "
            f"{', '.join(MOUNT_TYPES)}, not {mount_type!r}"
        )


def nonblank(value: str) -> bool:
    """Whether a configured id is a string with something in it.

    Args:
        value (str): the id as configured.
    """
    return isinstance(value, str) and bool(value.strip())


def require_id(runtime: str, name: str, value: str) -> None:
    """Fail loud on a required id that is blank, which would otherwise
    reach the provider as an empty name.

    Args:
        runtime (str): the runtime's name, for the message.
        name (str): the config field.
        value (str): the id as configured.
    """
    if not nonblank(value):
        raise ValueError(f"{runtime} config needs a nonblank {name}")
