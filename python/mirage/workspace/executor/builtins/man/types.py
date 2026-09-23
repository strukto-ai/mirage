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

from mirage.commands.spec.types import CommandSpec


@dataclass(frozen=True, slots=True)
class ManEntry:
    """One entry of the manual: a documented word and the spec its page
    renders from.

    A name has one spec however many mounts register it, so the entry
    carries no mount and no VFS; which backend serves the word is
    dispatch's business, not the manual's.

    Args:
        name (str): the word as the manual lists it.
        spec (CommandSpec): the spec the page renders from.
    """
    name: str
    spec: CommandSpec
