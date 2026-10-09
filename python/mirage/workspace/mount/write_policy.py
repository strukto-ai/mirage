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

import json
from urllib.parse import urlparse

from mirage.cache.types import WriteKind
from mirage.types import MountMode, WritePolicy
from mirage.vfs.base import BaseVFS
from mirage.vfs.types import EndpointVFS
from mirage.workspace.mount.constants import (
    AWS_DOMAINS,
    CUSTOM_ENDPOINT_CONDITIONS,
    WRITE_CONDITIONS,
)
from mirage.workspace.mount.errors import WritePolicyError


def coerce_write_policy(value: str | WritePolicy | None) -> WritePolicy:
    """Coerce a declared write-policy name into a WritePolicy.

    None and the empty string mean unconditional here; the entry points resolve
    an absent ``write:`` to the workspace default before asking.

    Args:
        value (str | WritePolicy | None): the requested policy; None and
            the empty string mean unconditional.

    Raises:
        WritePolicyError: the name is not a known policy.
    """
    if value is None or value == "":
        return WritePolicy.UNCONDITIONAL
    if isinstance(value, WritePolicy):
        return value
    try:
        return WritePolicy(str(value).lower())
    except ValueError:
        known = ", ".join(p.value for p in WritePolicy)
        json_shaped = isinstance(value, (bool, int, float, list, dict))
        shown = json.dumps(value) if json_shaped else f"'{value}'"
        raise WritePolicyError(
            f"unknown write policy {shown}; expected one of: {known}"
        ) from None


def _aws_endpoint(endpoint: str) -> bool:
    host = urlparse(endpoint).hostname or ""
    return any(
        host == domain or host.endswith("." + domain) for domain in AWS_DOMAINS
    )


def _endpoint(vfs: BaseVFS) -> str | None:
    return vfs.resolved_endpoint() if isinstance(vfs, EndpointVFS) else None


def write_conditions(vfs: BaseVFS) -> frozenset[WriteKind]:
    """The operations whose writes this mount's backend can condition.

    Args:
        vfs (BaseVFS): the backend being mounted.
    """
    conditions = WRITE_CONDITIONS.get(vfs.name, frozenset())
    if vfs.name != "s3":
        return conditions
    endpoint = _endpoint(vfs)
    if endpoint and not _aws_endpoint(endpoint):
        return CUSTOM_ENDPOINT_CONDITIONS
    return conditions


def check_write_capability(
    prefix: str,
    vfs: BaseVFS,
    policy: WritePolicy,
    mode: MountMode,
    caches: bool,
) -> None:
    """Refuse a write policy this mount cannot honour.

    A policy that cannot act must say so: a conditional mount whose
    writes would go out unconditioned is the silent downgrade the policy
    exists to remove, so it is refused at mount time.

    Args:
        prefix (str): the mount prefix, for the message.
        vfs (BaseVFS): the backend being mounted.
        policy (WritePolicy): the resolved policy.
        mode (MountMode): the mount's ceiling.
        caches (bool): whether the mount keeps a cached copy (the version
            a write sends is the one that copy holds).

    Raises:
        WritePolicyError: the mount cannot honour the declared policy.
    """
    if policy is WritePolicy.STAGED:
        raise WritePolicyError(
            f"mount {prefix!r}: write: staged needs a staging layer, and "
            "mirage has none; use conditional or unconditional"
        )
    if policy is not WritePolicy.CONDITIONAL:
        return
    if mode is MountMode.READ:
        raise WritePolicyError(
            f"mount {prefix!r}: write: conditional needs a writable mount; "
            "this one is read"
        )
    if not write_conditions(vfs):
        raise WritePolicyError(
            f"mount {prefix!r}: write: conditional needs a backend that "
            f"refuses a stale write; {vfs.name} does not"
        )
    if not caches:
        raise WritePolicyError(
            f"mount {prefix!r}: write: conditional needs a mount that "
            "caches reads; the version a write sends is the one its "
            "cached copy holds"
        )
