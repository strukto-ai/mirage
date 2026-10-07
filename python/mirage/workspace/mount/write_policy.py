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

from collections.abc import Iterable
from typing import Protocol, runtime_checkable
from urllib.parse import urlparse
from weakref import WeakKeyDictionary

from mirage.types import KERNEL_BACKENDS, MountBackend, MountMode, WritePolicy
from mirage.utils.path import norm_dir
from mirage.vfs.base import BaseVFS

_ALL = frozenset({"put", "create", "copy", "delete"})

# The ops each backend conditions (docs/home/yaml.mdx, conditions.json).
WRITE_CONDITIONS: dict[str, frozenset[str]] = {
    "s3": _ALL,
    "seaweedfs": _ALL,
    "minio": frozenset({"put", "create"}),
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

# A `type: s3` mount on another endpoint can be any S3-compatible server,
# MinIO included, so it is trusted only as far as MinIO is.
CUSTOM_ENDPOINT_CONDITIONS: frozenset[str] = WRITE_CONDITIONS["minio"]

# The domains AWS serves S3 from: the commercial partitions and China.
AWS_DOMAINS = ("amazonaws.com", "amazonaws.com.cn")

# Each s3 VFS's resolved row, computed once: the client's endpoint is fixed
# when the mount is built, and building a client per op would be a cost.
_resolved: WeakKeyDictionary[BaseVFS, frozenset[str]] = WeakKeyDictionary()


class PolicyMount(Protocol):
    """What the exposure check reads off a mount."""

    prefix: str
    write: WritePolicy


def conditional_overlap(
    mounts: Iterable[PolicyMount], prefix: str
) -> str | None:
    """The prefix of a conditional mount an exposure of ``prefix`` reaches.

    An exposure reaches a mount when it covers it (``/`` covers ``/s3/``)
    or sits inside it (``/s3/sub`` is inside ``/s3/``).

    Args:
        mounts (Iterable[PolicyMount]): the workspace's mounts.
        prefix (str): the subtree about to be exposed.
    """
    for m in mounts:
        if m.write is not WritePolicy.CONDITIONAL:
            continue
        if exposure_overlaps(m.prefix, prefix):
            return m.prefix
    return None


def exposure_overlaps(mount_prefix: str, exposed: str) -> bool:
    """Whether exposing ``exposed`` reaches the mount at ``mount_prefix``.

    It does when it covers the mount (``/`` covers ``/s3/``) or sits
    inside it (``/s3/sub`` is inside ``/s3/``).

    Args:
        mount_prefix (str): the mount's prefix.
        exposed (str): the subtree exposed.
    """
    mount, out = norm_dir(mount_prefix), norm_dir(exposed)
    return mount.startswith(out) or out.startswith(mount)


def kernel_refusal(prefix: str, backend: str | MountBackend) -> str:
    """The refusal for a conditional mount a kernel mount would expose.

    Args:
        prefix (str): the conditional mount's prefix.
        backend (str | MountBackend): fuse or fskit.
    """
    return (
        f"mount {norm_dir(prefix)!r}: write: conditional cannot be exposed "
        f"through backend {MountBackend(backend).value}, which has no place "
        "to carry the version"
    )


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
    """A backend that knows the endpoint its client sends to."""

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
    known = _resolved.get(vfs)
    if known is None:
        endpoint = _endpoint(vfs)
        known = (
            CUSTOM_ENDPOINT_CONDITIONS
            if endpoint and not _aws_endpoint(endpoint)
            else conditions
        )
        _resolved[vfs] = known
    return known


def check_write_capability(
    prefix: str,
    vfs: BaseVFS,
    policy: WritePolicy,
    mode: MountMode,
    backend: MountBackend,
    caches: bool,
) -> None:
    """Refuse a write policy this mount cannot honour.

    A policy that cannot act must say so: a conditional mount whose
    writes would go out unconditioned is the silent downgrade the policy
    exists to remove, so it is refused at mount time. The arms are
    ordered, and the order is part of the contract both hosts share.

    Args:
        prefix (str): the mount prefix, for the message.
        vfs (BaseVFS): the backend being mounted.
        policy (WritePolicy): the resolved policy.
        mode (MountMode): the mount's ceiling.
        backend (MountBackend): how the mount is exposed.
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
    if backend in KERNEL_BACKENDS:
        raise ValueError(kernel_refusal(prefix, backend))
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
