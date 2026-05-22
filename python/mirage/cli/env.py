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

from mirage.server.auth.config import (ENV_AUTH_MODE, ENV_AUTH_TOKEN,
                                       ENV_JWT_ALG, ENV_JWT_AUDIENCE,
                                       ENV_JWT_AUTHORIZED_PARTIES,
                                       ENV_JWT_CLOCK_SKEW, ENV_JWT_ISSUER,
                                       ENV_JWT_PUBKEY, ENV_JWT_PUBKEY_FILE)
from mirage.server.env import ENV_IDLE_GRACE_SECONDS

ENV_DAEMON_URL = "MIRAGE_DAEMON_URL"
ENV_TOKEN = "MIRAGE_TOKEN"

__all__ = [
    "ENV_AUTH_MODE",
    "ENV_AUTH_TOKEN",
    "ENV_DAEMON_URL",
    "ENV_IDLE_GRACE_SECONDS",
    "ENV_JWT_ALG",
    "ENV_JWT_AUDIENCE",
    "ENV_JWT_AUTHORIZED_PARTIES",
    "ENV_JWT_CLOCK_SKEW",
    "ENV_JWT_ISSUER",
    "ENV_JWT_PUBKEY",
    "ENV_JWT_PUBKEY_FILE",
    "ENV_TOKEN",
]
