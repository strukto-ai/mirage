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

import os

from mirage.secrets.config import EnvConfig
from mirage.secrets.errors import SecretsError
from mirage.secrets.types import ResolvedSecret


async def fetch_env(config: EnvConfig, ref: str) -> ResolvedSecret:
    """Read the host process environment as one secret.

    Args:
        config (EnvConfig): carries nothing; the process env has no
            settings.
        ref (str): must be empty; a managed entry's ``key`` selects the
            variable to read.

    Returns:
        ResolvedSecret: the whole process environment as fields.

    Raises:
        SecretsError: a non-empty ``ref``; the process env has no
            sub-address.
    """
    if ref:
        raise SecretsError("the 'env' source takes no ref (the process "
                           f"env has no sub-address), got {ref!r}")
    return ResolvedSecret(fields=dict(os.environ))
