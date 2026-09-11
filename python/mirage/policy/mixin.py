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

from abc import ABC, abstractmethod


class SessionScopedMixin(ABC):
    """A policy whose hooks speak for some sessions and not others.

    A true mixin: no state, no constructor, one method. A Policy that
    also inherits this overrides a hook on behalf of the sessions that
    carry a rule for it (a profile's policy program speaks only for the
    sessions under that profile), and says so through ``wants_for``.
    ``Policies.wants`` is the static answer, true as soon as any policy
    overrides the hook, and every door keeps gating on it; a seam that
    pays ahead for a hook (the secret fill drops its masks under a
    session-write gate) asks ``Policies.wants_for`` instead, which
    consults this mixin so one profile's door does not charge every
    session.
    """

    @abstractmethod
    async def wants_for(self, hook: str, session_id: str) -> bool:
        """Whether this policy's ``hook`` will speak for one session.

        Args:
            hook (str): the hook name (``pre_command``, ``pre_ops``,
                ``pre_session``, ...).
            session_id (str): the session, empty when none is bound.
        """
