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

from mirage.commands.cli.builtin.hf.accessor import text_out
from mirage.commands.config import Context
from mirage.core.hf_hub.config import HfConfig
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.version import __version__


async def env_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Print what this install is pointed at.

    Upstream prints the local machine's python, platform and cache
    layout. None of those describe what an agent is talking to, and two
    of them do not exist in a workspace, so this reports the facts that
    do: the endpoint, whether a token is set, and the version.
    """
    token = "set" if config.token is not None else "not set"
    lines = [
        "- huggingface_hub version: mirage",
        f"- mirage version: {__version__}",
        f"- endpoint: {config.endpoint}",
        f"- token: {token}",
    ]
    return text_out("\n".join(lines) + "\n")


async def version_cmd(
    config: HfConfig, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Print the version."""
    return text_out(f"hf version {__version__} (mirage)\n")
