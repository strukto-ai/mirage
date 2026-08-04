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

from mirage.workspace.executor.builtins.lookup.constants import (
    DESCRIPTIONS, KIND_BY_CONSUMER)
from mirage.workspace.executor.builtins.lookup.types import NameKind
from mirage.workspace.mount import MountRegistry
from mirage.workspace.names import KEYWORDS
from mirage.workspace.route import route, route_all
from mirage.workspace.session import Session


def classify(name: str, session: Session,
             registry: MountRegistry) -> NameKind | None:
    """Classify the name as the layer that would run it, None if none does.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    if name in KEYWORDS:
        return NameKind.KEYWORD
    return KIND_BY_CONSUMER.get(route(name, session, registry))


def classify_all(name: str, session: Session,
                 registry: MountRegistry) -> list[NameKind]:
    """Classify every layer holding the name, most-preferred first.

    A reserved word goes first and does not end the walk: bash prints
    both lines when a function shares a keyword's name (pinned:
    ``function time { :; }; type -a time`` prints the keyword line then
    the function line). mirage's parser is looser than bash's about
    reserved words as function names, so the shadow is reachable here
    for any of them, and hiding it would leave ``type -a`` claiming a
    keyword while the line runs the function.

    Duplicate kinds are dropped, since the kinds are coarser than the
    layers: a shell builtin that a mount also registers is one
    ``builtin`` line, not two identical ones.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
    """
    kinds: list[NameKind] = [NameKind.KEYWORD] if name in KEYWORDS else []
    for consumer in route_all(name, session, registry):
        kind = KIND_BY_CONSUMER[consumer]
        if kind not in kinds:
            kinds.append(kind)
    return kinds


def locations(name: str,
              session: Session,
              registry: MountRegistry,
              all_mode: bool,
              drop: NameKind | None = None) -> list[NameKind]:
    """The kinds to report for one name: hide a layer, then take the top.

    Hiding is a filter over the layer list, never an edit to the
    session, and it runs before the winner is picked. That order is
    what keeps the winner honest: ``type -f`` reports the layer under a
    shadowing function, and ``which`` the layer under a reserved word,
    where filtering afterwards would report nothing at all.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.
        all_mode (bool): report every layer instead of the winner only.
        drop (NameKind | None): a layer this caller does not resolve.
    """
    kinds = classify_all(name, session, registry)
    if drop is not None:
        kinds = [kind for kind in kinds if kind is not drop]
    return kinds if all_mode else kinds[:1]


def describe(name: str, kind: NameKind) -> str:
    """Render the verbose line ``command -V`` and ``type`` print.

    Args:
        name (str): the operand word.
        kind (NameKind): the classification.
    """
    return f"{name} is {DESCRIPTIONS[kind]}"
