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

from typing import Any

from mirage.types import Refusal


class PolicyError(Exception):
    """A policy returned something a hook may not return.

    Raised loudly at the seam (never silently dropped): an illegal
    Action kind for the hook, or a value that is not an Action at all,
    is a programming error in the policy, not a refusal.
    """


class Explained(Exception):
    """A dry run reached the op gate: the door stops there, before any
    backend or cache is touched, with what the gate would answer noted
    for ``session.explain.vfs``."""


class PolicyDenied(PermissionError):
    """An op or a session write refused by an admission policy at a door.

    A PermissionError subclass so every existing consumer keeps
    working: FUSE adapters classify it to EACCES, programmatic callers
    catch PermissionError, and the shell renders the GNU
    ``<cmd>: <path>: Permission denied`` line. The distinct type lets
    handlers that special-case mount-mode refusals (the read-only
    wording) tell a policy deny apart without guessing from errno.

    The error says what the terminal would (``Permission denied`` at an
    op door, ``<name>: permission denied`` at the session door), and
    the policy's own words ride ``refusal``, never the strerror, so a
    door that renders the error stays byte-identical to a plain EACCES
    and a door that hands the agent text appends the record's line.

    It carries no accounting: a post_vfs refusal suppresses the result,
    not the effect, and the door reports the completed op through the
    caller's ``OpReport``, which covers this error and any foreign one
    the same way.

    Args:
        *args: the OSError arguments (errno, strerror, filename).
        refusal (Refusal | None): the policy's record, None for a door
            that refuses on no policy's behalf (a hidden variable).
    """

    def __init__(self, *args: Any, refusal: Refusal | None = None) -> None:
        super().__init__(*args)
        self.refusal = refusal
