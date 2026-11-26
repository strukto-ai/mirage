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

from collections.abc import Mapping

ENV_ALLOWED_HOSTS = "MIRAGE_ALLOWED_HOSTS"
ENV_E2B_PORT = "MIRAGE_E2B_PORT"
ENV_FORWARDED_ALLOW_IPS = "MIRAGE_FORWARDED_ALLOW_IPS"
ENV_GRACEFUL_TIMEOUT = "MIRAGE_GRACEFUL_TIMEOUT"
ENV_IDLE_GRACE_SECONDS = "MIRAGE_IDLE_GRACE_SECONDS"
ENV_MAX_ENV = "MIRAGE_MAX_ENV"
ENV_MAX_LINE_SECONDS = "MIRAGE_MAX_LINE_SECONDS"
ENV_MAX_MEMORY = "MIRAGE_MAX_MEMORY"
ENV_MAX_PROCESSES = "MIRAGE_MAX_PROCESSES"
ENV_MAX_SESSIONS = "MIRAGE_MAX_SESSIONS"
ENV_MAX_WORKSPACES = "MIRAGE_MAX_WORKSPACES"
ENV_POLICY_FILE = "MIRAGE_POLICY_FILE"
ENV_RATE_LIMITS = "MIRAGE_RATE_LIMITS"
ENV_RESOURCE_STORE = "MIRAGE_RESOURCE_STORE"
ENV_TRACE_CONTEXT = ("TRACEPARENT", "TRACESTATE")
ENV_DAEMON_PORT = "MIRAGE_DAEMON_PORT"
ENV_HOME = "MIRAGE_HOME"
ENV_WORKERS = "MIRAGE_WORKERS"
ENV_WORKER_TYPE = "MIRAGE_WORKER_TYPE"
ENV_WORKER_SOCKET = "MIRAGE_WORKER_SOCKET"
ENV_WORKER_TOKEN = "MIRAGE_WORKER_TOKEN"


def trace_headers(env: Mapping[str, str]) -> dict[str, str]:
    """The W3C trace headers an environment holds: ``TRACEPARENT`` as
    ``traceparent`` and ``TRACESTATE`` as ``tracestate``. ``BAGGAGE`` is
    left out: it can hold anything the environment's owner put there.

    Args:
        env (Mapping[str, str]): the environment, a process's or the one
            an SSH client sent.
    """
    return {
        name.lower(): value
        for name in ENV_TRACE_CONTEXT
        if (value := env.get(name))
    }
