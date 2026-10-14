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
from dataclasses import replace

from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)

_sequence = itertools.count(1)


def tick() -> int:
    """The next point in the one order commands and listing writes share.

    A sequence rather than a clock: two events in the same clock tick still
    come out ordered, so "written after this command started" is exact.
    """
    return next(_sequence)


def command_started() -> int | None:
    """When the running command started, or None outside any command."""
    return current_caller().command_started


@asynccontextmanager
async def command_scope() -> AsyncIterator[None]:
    """Mark one command's run, so a fresh listing it writes can be trusted.

    Entered before the command's words expand, so its own globs count. A
    nested command (a ``$(...)``, a function body) gets its own later
    stamp, and the outer one comes back when it ends.
    """
    token = bind_caller(replace(current_caller(), command_started=tick()))
    try:
        yield
    finally:
        reset_caller(token)
