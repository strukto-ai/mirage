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
from dataclasses import dataclass, field

from mirage.cli.constants import LOCAL


@dataclass
class Context:
    """One server the CLI talks to, with what it remembers there.

    Args:
        url (str): the server; empty for ``local``, whose URL follows
            the daemon's port.
        team (str | None): the team the login acts for, if the server
            names one.
        workspace (str | None): the workspace commands use when given
            none.
    """

    url: str = ""
    team: str | None = None
    workspace: str | None = None


@dataclass
class Contexts:
    """The contexts file: which context is current, and every context.

    Args:
        current (str): the current context's name.
        contexts (dict[str, Context]): every context by name; ``local``
            is always there.
    """

    current: str = LOCAL
    contexts: dict[str, Context] = field(default_factory=dict)
