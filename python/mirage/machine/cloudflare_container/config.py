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

from mirage.machine.config import MachineConfig


@dataclass(frozen=True, slots=True, kw_only=True)
class ContainerConfig(MachineConfig):
    """How a Cloudflare Container is reached: through a
    ``ContainerRelay`` at ``url``. Its image, instance type and network
    belong to the Durable Object that starts it, so no config names them.

    Args:
        url (str | None): the relay route that names the container
            (``https://relay.example.workers.dev/box``).
        token (str | None): the relay's token, its MIRAGE_RELAY_TOKEN
            secret; required with ``url``.
    """

    url: str | None = None
    token: str | None = None
