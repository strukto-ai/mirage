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

import itertools
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar

_sequence = itertools.count(1)
_started: ContextVar[int | None] = ContextVar("_command_started", default=None)


def tick() -> int:
    """The next point in the one order commands and listing writes share.

    A sequence rather than a clock: two events in the same clock tick still
    come out ordered, so "written after this command started" is exact.
    """
    return next(_sequence)


def command_started() -> int | None:
    """When the running command started, or None outside any command."""
    return _started.get()


def sole_command_started() -> int | None:
    """The running command's own stamp, for a check that it fetched a listing.

    A task's context holds only its own stamp, so this is
    ``command_started``. Mirrors TS ``soleCommandStarted``, which answers
    None where the browser storage cannot tell one live command from
    another.
    """
    return _started.get()


@asynccontextmanager
async def command_scope() -> AsyncIterator[None]:
    """Mark one command's run, so a fresh listing it writes can be trusted.

    Entered before the command's words expand, so its own globs count. A
    nested command (a ``$(...)``, a function body) gets its own later
    stamp, and the outer one comes back when it ends.
    """
    token = _started.set(tick())
    try:
        yield
    finally:
        _started.reset(token)
