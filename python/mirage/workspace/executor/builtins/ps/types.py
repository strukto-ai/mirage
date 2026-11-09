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

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import tzinfo


@dataclass(frozen=True, slots=True)
class PsOptions:
    """What a ps line selects and prints.

    Args:
        pids (frozenset[int]): ``-p`` selection, empty for none.
        all (bool): a letter that selects every process was given.
        columns (tuple[tuple[str, str], ...]): ``-o`` keys and headers.
        forest (bool): BSD ``f`` or ``--forest``, which draws each
            command under its parent's.
    """

    pids: frozenset[int]
    all: bool
    columns: tuple[tuple[str, str], ...]
    forest: bool = False


@dataclass(frozen=True, slots=True)
class PsContext:
    """What every row of one ps line reads besides its runner.

    Args:
        now (float): the moment ps runs, epoch seconds.
        zone (tzinfo | None): the zone times print in, the session's TZ.
        group (str | None): the session's profile, its runners' owner
            and group.
        session_id (str): the calling session.
        shell_pid (int | None): the calling session's ``$$``.
        running (int | None): the process running this ``ps``.
        shown (Mapping[int, int]): each process's pid as the agent sees
            it, by Mirage's own number for it.
    """

    now: float
    zone: tzinfo | None
    group: str | None
    session_id: str
    shell_pid: int | None
    running: int | None
    shown: Mapping[int, int]
