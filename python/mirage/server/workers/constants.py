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

from mirage.server.workers.types import Answer

# How long a worker has to answer its health check once started.
READY_SECONDS = 60
# How long a stopped worker has to exit before it is killed, past the
# graceful timeout it drains for.
EXIT_SECONDS = 10
# A request that needs no workspace and answers only a signed-in caller:
# what a worker says to it says whether the caller may go on.
AUTH_PROBE = "/v1/workspaces"
# Headers that belong to one connection, which are not passed on.
HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    }
)
# What a request gets when no worker can answer it.
UNAVAILABLE = Answer(
    502,
    [("content-type", "application/json")],
    b'{"detail":"worker unavailable"}',
)
