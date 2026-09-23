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

from mirage.types import DEFAULT_READ_TTL, JsonValue, ReadPolicy, ReadSpec
from mirage.vfs.base import BaseVFS


def coerce_read_policy(value: "str | ReadPolicy | None") -> ReadPolicy:
    """Coerce a declared read-policy name into a ReadPolicy.

    Missing means bounded, everywhere: an absent ``read:`` in YAML,
    ``None`` here, and the ``Mount`` dataclass default all resolve to
    the same thing.

    Args:
        value (str | ReadPolicy | None): the requested policy; None and
            the empty string mean bounded.

    Returns:
        ReadPolicy: the resolved policy.

    Raises:
        ValueError: the name is not a known policy.
    """
    if value is None or value == "":
        return ReadPolicy.BOUNDED
    # Already coerced: `str()` of a (str, Enum) member renders as
    # "ReadPolicy.BOUNDED", so re-coercing one would refuse it. The
    # config door validates the field and then builds the spec, so the
    # value arrives here twice. Mirrors `_coerce_mount_mode`.
    if isinstance(value, ReadPolicy):
        return value
    try:
        return ReadPolicy(str(value).lower())
    except ValueError:
        known = ", ".join(p.value for p in ReadPolicy)
        # `from None`: the inner error is `Enum.__call__`'s own "'x' is
        # not a valid ReadPolicy", which carries nothing this message
        # does not and would otherwise be the first thing a user with a
        # YAML typo reads, under a "During handling of the above
        # exception" banner.
        raise ValueError(f"unknown read policy {value!r}; expected one of: "
                         f"{known}") from None


def coerce_read_ttl(value: JsonValue) -> int:
    """Coerce a declared bound to a whole number of seconds.

    Every door that reads a bound off a document runs this, so one
    scalar is judged the same whether it came from YAML or from a
    snapshot's JSON.

    An integral float is a bound, not a typo: JavaScript has one number
    type, so `ttl: 60.0` reaches ``coerceReadPolicy``'s twin as plain
    `60` and there is no predicate TypeScript could write that tells the
    two spellings apart. Refusing it here would load a document on one
    host and fail it on the other. A fractional float, a quoted number
    and a bool are refused on both.

    Args:
        value (JsonValue): the declared bound, as the document spelled
            it.

    Returns:
        int: the bound in whole seconds.

    Raises:
        ValueError: the value is not a whole number of seconds.
    """
    # Bools first: `bool` is a subclass of `int`, so `ttl: true` would
    # otherwise pass as a one-second bound.
    if isinstance(value, bool):
        raise ValueError(f"ttl must be whole seconds, got {value!r}")
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    raise ValueError(f"ttl must be whole seconds, got {value!r}")


def resolve_read_spec(policy: "str | ReadPolicy | None",
                      ttl: JsonValue) -> ReadSpec:
    """Coerce a declared read policy and bound into a ReadSpec.

    Coercion only: an unknown name is refused here, but whether the
    resolved policy is one this mount's backend can honour is
    ``check_read_capability``'s question. The two are split the way
    ``fuse/backend.py`` splits ``resolve_backend`` from
    ``require_kernel_backend``, so the config door and the mount door
    each run exactly one of them and a refusal is computed once.

    Missing means bounded at the default bound, everywhere: an absent
    ``read:`` in YAML, ``None`` here, and the ``Mount`` dataclass
    default all resolve to the same thing.

    Args:
        policy (str | ReadPolicy | None): the requested policy; None
            and the empty string mean bounded.
        ttl (JsonValue): the requested bound in seconds, as the
            document spelled it; None means the default.

    Returns:
        ReadSpec: the resolved policy and bound.

    Raises:
        ValueError: the policy name is not a known one, or the bound is
            not a positive whole number of seconds.
    """
    # Policy first, bound second, matching `resolveReadSpec`. A config
    # wrong in both ways has to be refused the same way on both hosts,
    # or `integ/fixtures/config/rejected.json` compares two different
    # messages for one document.
    resolved_policy = coerce_read_policy(policy)
    resolved = DEFAULT_READ_TTL if ttl is None else coerce_read_ttl(ttl)
    # A non-positive bound is not a very short one: the store marks such
    # an entry expired the moment it is written (redis EXPIRE <= 0 deletes
    # the key outright), so the mount silently caches nothing. Refusing it
    # is the other half of the rule that refuses `bounded` with no bound.
    if resolved < 1:
        raise ValueError(f"ttl must be at least 1 second, got {resolved}")
    return ReadSpec(policy=resolved_policy, ttl=resolved)


def check_read_capability(prefix: str, vfs: BaseVFS, spec: ReadSpec) -> None:
    """Refuse a read policy this mount's backend cannot honour.

    The rules are ordered, and the order is the answer to two questions
    that collide on a disk mount: whether the gate can fire at all, and
    whether the token behind it is worth comparing. A backend that does
    not cache reads is answered by the first and never reaches the
    second.

    A policy that cannot act must say so. Degrading ``fresh`` to
    ``bounded`` on a backend that cannot revalidate is the silent
    downgrade this whole policy exists to remove, so it is a refusal at
    mount time rather than a warning at read time.

    Args:
        prefix (str): the mount prefix, for the message.
        vfs (BaseVFS): the backend being mounted.
        spec (ReadSpec): the resolved policy and bound.

    Raises:
        ValueError: the backend cannot honour the declared policy.
    """
    # Coerced, not compared raw. `ReadPolicy` is a (str, Enum) and
    # `ReadSpec` coerces nothing, so an embedder's
    # `ReadSpec(policy="fresh")` would match neither `is` below and the
    # whole verdict would silently no-op on the one door -- the
    # programmatic one -- that does not pass through `resolve_read_spec`.
    # Idempotent on a member, and it refuses a name that is not a policy
    # at all. `MountEntry` stores the coerced spec for the same reason.
    #
    # Policy first, bound second, the order `resolve_read_spec` and
    # `resolveReadSpec` both take. Judging the bound first here meant
    # one `ReadSpec(policy="banana", ttl=0)` came back naming the bound
    # on this host and the policy on the other.
    policy = coerce_read_policy(spec.policy)
    # Before the policy dispatch, because a bound has to be usable
    # whatever the policy is. `resolve_read_spec` refuses a bad one at
    # the YAML and snapshot doors, but a `ReadSpec` handed straight to
    # `Workspace` or `add_mount` never passes through it, and a mount
    # taking ttl=0 accepts every write and keeps nothing: RAM marks the
    # entry expired as it is written and redis deletes the key outright,
    # so the mount silently caches nothing at all.
    if not isinstance(spec.ttl, int) or isinstance(spec.ttl, bool):
        raise ValueError(f"mount {prefix!r}: read: ttl must be whole "
                         f"seconds, got {spec.ttl!r}")
    if spec.ttl < 1:
        raise ValueError(f"mount {prefix!r}: read: ttl must be at least "
                         f"1 second, got {spec.ttl}")
    if policy is ReadPolicy.PINNED:
        raise ValueError(
            f"mount {prefix!r}: read: pinned needs a version layer to pin "
            "to, and mirage has none; use fresh or bounded")
    if policy is not ReadPolicy.FRESH:
        return
    # VFSName is a (str, Enum), whose str() is "VFSName.RAM"; a VFS
    # registered from a script carries a plain string. Both read as the
    # wire name through .value.
    name = getattr(vfs.name, "value", vfs.name)
    # The instance attribute, not the class: lancedb decides per config
    # whether it caches reads.
    if not vfs.caches_reads:
        raise ValueError(
            f"mount {prefix!r}: read: fresh needs a resource that caches "
            f"reads; {name} does not, so the freshness check could "
            "never run")
    if not vfs.READ_REVALIDATABLE:
        raise ValueError(
            f"mount {prefix!r}: read: fresh needs a resource that stamps a "
            f"comparable content token on reads; {name} does not")
