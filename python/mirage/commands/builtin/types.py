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

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True, slots=True)
class ExecAction:
    """One ``-exec`` action: the command words and how it is run.

    Args:
        argv (tuple[str, ...]): the words between ``-exec`` and its
            terminator, ``{}`` still in place.
        batch (bool): ``{} +`` (one run over every match) rather than
            ``;`` (one run per match).
    """
    argv: tuple[str, ...]
    batch: bool = False


RowActionKind = Literal["print", "print0", "ls", "delete"]


@dataclass(frozen=True, slots=True)
class RowAction:
    """One of find's row actions, in the position it was written.

    Args:
        kind (RowActionKind): ``-print``, ``-print0``, ``-ls`` or
            ``-delete``.
    """
    kind: RowActionKind


FindAction = ExecAction | RowAction
