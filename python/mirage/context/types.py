from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING

from mirage.observe.context import Recorder
from mirage.types import EntryGate, MountMode, Visibility, WalkProbe

if TYPE_CHECKING:
    from mirage.policy.policies import Policies


@dataclass(frozen=True)
class IOContext:
    """The caller's access facts carried through a filesystem operation."""

    session_id: str
    visibility: Visibility
    mount_modes: Mapping[str, MountMode] | None
    umask: int
    dotglob: bool
    admission: EntryGate | None = None
    recorder: Recorder | None = None
    policies: "Policies | None" = None
    mount_gate: tuple[str, MountMode] | None = None
    walk_probe: WalkProbe | None = None
    judged_targets: tuple[str, ...] = ()
