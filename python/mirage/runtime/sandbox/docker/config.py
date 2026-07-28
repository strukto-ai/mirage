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

from mirage.runtime.sandbox.config import SandboxConfig


@dataclass(frozen=True, slots=True)
class DockerConfig(SandboxConfig):
    """The docker machine config, mapped onto the docker CLI.

    ``disk`` is deliberately not a field: the default storage driver
    has no per-container limit. Templates and SDK params are not
    fields either; docker boots images and is driven by CLI flags.

    Args:
        image (str | None): image to boot, pulled on first use
            (python:3.12-slim when omitted).
        cpu (int | None): CPU cores, mapped onto --cpus.
        memory (int | None): memory in GiB, mapped onto --memory.
        gpu (int | str | None): GPU count or spec, mapped onto --gpus.
        args (list[str]): extra `docker run` flags passed verbatim
            before the image (binds, --cap-add, --network, --user).
    """

    image: str | None = None
    cpu: int | None = None
    memory: int | None = None
    gpu: int | str | None = None
    args: list[str] = field(default_factory=list)
