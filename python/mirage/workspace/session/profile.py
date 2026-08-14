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

from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from mirage.types import HiddenPaths, HiddenVars, MountMode


@dataclass(frozen=True, slots=True)
class SessionProfile:
    """One role's narrowing, bundled for ``create_session(profile=...)``.

    Configuration, not enforcement: the fields unpack onto the
    session's own narrowing fields and the doors keep enforcing.
    Deliberately not named a View — per the view convention a View is
    a door-scoped handle an agent holds, while a profile is what the
    embedder uses to *define* one. Frozen so two agents with the same
    role share one object and neither can bend the other's view.

    Args:
        mounts (Mapping[str, MountMode | str] | Iterable[str] | None):
            per-mount mode ceilings, the same spellings
            ``create_session`` accepts directly; None leaves mounts
            unrestricted.
        hidden_paths (HiddenPaths | None): paths the data door treats
            as nonexistent for the session.
        hidden_vars (HiddenVars | None): variables the session door
            treats as unset for the session.
        env (Mapping[str, str] | None): preset variables seeded into
            the session environment at creation.
    """

    mounts: Mapping[str, MountMode | str] | Iterable[str] | None = None
    hidden_paths: HiddenPaths | None = None
    hidden_vars: HiddenVars | None = None
    env: Mapping[str, str] | None = None
