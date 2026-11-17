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

from mirage.runtime.config import RuntimeConfig, memory_limit
from mirage.runtime.python.monty.constants import LOGFIRE_KEY, LOGFIRE_REGIONS


@dataclass(frozen=True, slots=True)
class MontyConfig(RuntimeConfig):
    """Config for the monty runtime.

    Args:
        max_memory (str | int | None): the heap one run may use, spelled as
            sandlock spells its own (``10M``, ``1G``); a run that needs
            more raises ``MemoryError``. None for no cap.
        url (str | None): a remote Monty server to run on instead of
            local workers (``provider: remote``); None runs locally, or on
            the Logfire region ``api_key`` names.
        api_key (str | None): the server's bearer token; None sends none.
    """

    max_memory: str | int | None = None
    url: str | None = None
    api_key: str | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        memory_limit(self.max_memory)
        if self.api_key is not None and remote_url(self) is None:
            raise ValueError(
                "monty: api_key needs a url, unless it is a Logfire key"
                " from a known region"
            )


def remote_url(config: MontyConfig) -> str | None:
    """The remote server a config runs on: its ``url``, else the server of
    the Logfire region its ``api_key`` names; None for local workers.

    Args:
        config (MontyConfig): the runtime's config.
    """
    if config.url is not None:
        return config.url
    found = (
        None if config.api_key is None else LOGFIRE_KEY.match(config.api_key)
    )
    return None if found is None else LOGFIRE_REGIONS.get(found.group(1))
