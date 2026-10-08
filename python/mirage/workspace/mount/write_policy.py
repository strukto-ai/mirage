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

from typing import Protocol, runtime_checkable
from urllib.parse import urlparse

from mirage.types import MountMode, WritePolicy
from mirage.vfs.base import BaseVFS

_ALL = frozenset({"put", "copy", "delete"})

# The ops each backend conditions (docs/home/yaml.mdx, conditions.json).
WRITE_CONDITIONS: dict[str, frozenset[str]] = {
    "s3": _ALL,
    "seaweedfs": _ALL,
    "minio": frozenset({"put"}),
    "aliyun": _ALL,
    "backblaze": _ALL,
    "ceph": _ALL,
    "digitalocean": _ALL,
    "gcs": _ALL,
    "oci": _ALL,
    "qingstor": _ALL,
    "r2": _ALL,
    "scaleway": _ALL,
    "supabase": _ALL,
    "tencent": _ALL,
    "wasabi": _ALL,
}

# A custom `type: s3` endpoint may be MinIO, so it gets MinIO's row.
CUSTOM_ENDPOINT_CONDITIONS: frozenset[str] = WRITE_CONDITIONS["minio"]

# The domains AWS serves S3 from: the commercial partitions and China.
AWS_DOMAINS = ("amazonaws.com", "amazonaws.com.cn")


def coerce_write_policy(value: str | WritePolicy | None) -> WritePolicy:
    """Coerce a declared write-policy name into a WritePolicy.

    Missing means unconditional: an absent ``write:`` in YAML, ``None``
    here and the ``Mount`` default all resolve to it.

    Args:
        value (str | WritePolicy | None): the requested policy; None and
            the empty string mean unconditional.

    Raises:
        ValueError: the name is not a known policy.
    """
    if value is None or value == "":
        return WritePolicy.UNCONDITIONAL
    if isinstance(value, WritePolicy):
        return value
    try:
        return WritePolicy(str(value).lower())
    except ValueError:
        known = ", ".join(p.value for p in WritePolicy)
        raise ValueError(
            f"unknown write policy {value!r}; expected one of: {known}"
        ) from None


def _aws_endpoint(endpoint: str) -> bool:
    host = urlparse(endpoint).hostname or ""
    return any(
        host == domain or host.endswith("." + domain) for domain in AWS_DOMAINS
    )


@runtime_checkable
class EndpointVFS(Protocol):
    """A backend that declares the endpoint its writes go to."""

    def resolved_endpoint(self) -> str | None: ...


def _endpoint(vfs: BaseVFS) -> str | None:
    return vfs.resolved_endpoint() if isinstance(vfs, EndpointVFS) else None


def write_conditions(vfs: BaseVFS) -> frozenset[str]:
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
        ValueError: the mount cannot honour the declared policy.
    """
    policy = coerce_write_policy(policy)
    if policy is WritePolicy.STAGED:
        raise ValueError(
            f"mount {prefix!r}: write: staged needs a staging layer, and "
            "mirage has none; use conditional or unconditional"
        )
    if policy is not WritePolicy.CONDITIONAL:
        return
    if mode is MountMode.READ:
        raise ValueError(
            f"mount {prefix!r}: write: conditional needs a writable mount; "
            "this one is read"
        )
    if not write_conditions(vfs):
        raise ValueError(
            f"mount {prefix!r}: write: conditional needs a backend that "
            f"refuses a stale write; {vfs.name} does not"
        )
    if not caches:
        raise ValueError(
            f"mount {prefix!r}: write: conditional needs a mount that "
            "caches reads; the version a write sends is the one its "
            "cached copy holds"
        )
