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

import logging
import os
from collections import Counter
from collections.abc import Mapping

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from mirage.execution.types import ExecutionStatus
from mirage.server.jobs import ExecutionTable
from mirage.server.registry import WorkspaceRegistry

logger = logging.getLogger(__name__)

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

_RUNNING = frozenset({ExecutionStatus.RUNNING, ExecutionStatus.STOPPING})


class MetricsMiddleware:
    """ASGI middleware counting the responses the server sends, by status
    code, for ``/v1/metrics``: refusals show as their 403, 429 and 503.

    Args:
        app (ASGIApp): downstream ASGI app.
        responses (Counter[int]): the counts, by status code.
    """

    def __init__(self, app: ASGIApp, responses: Counter[int]) -> None:
        self.app = app
        self.responses = responses

    async def __call__(
        self, scope: Scope, receive: Receive, send: Send
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def counted(message: Message) -> None:
            if message["type"] == "http.response.start":
                self.responses[message["status"]] += 1
            await send(message)

        await self.app(scope, receive, counted)


def render_metrics(
    registry: WorkspaceRegistry,
    jobs: ExecutionTable,
    uptime: float,
    responses: Mapping[int, int],
) -> str:
    """The server's metrics in Prometheus's text format: workspaces,
    sessions, running jobs, whether it drains, the responses it sent by
    status code, and its resident memory where the system reports it.
    Mirrors TypeScript's ``renderMetrics``.

    Args:
        registry (WorkspaceRegistry): the server's workspaces.
        jobs (ExecutionTable): the lines its API runs.
        uptime (float): seconds since it started.
        responses (Mapping[int, int]): the responses it sent, by status
            code.
    """
    lines = [
        *_metric(
            "mirage_uptime_seconds",
            "gauge",
            "Seconds since the server started.",
            [("", round(uptime, 3))],
        ),
        *_metric(
            "mirage_workspaces",
            "gauge",
            "Workspaces the server holds.",
            [("", len(registry))],
        ),
    ]
    if registry.max_workspaces is not None:
        lines += _metric(
            "mirage_max_workspaces",
            "gauge",
            "The most workspaces the server holds at once.",
            [("", registry.max_workspaces)],
        )
    lines += [
        *_metric(
            "mirage_sessions",
            "gauge",
            "Sessions across the server's workspaces.",
            [
                (
                    "",
                    sum(
                        len(entry.runner.ws.list_sessions())
                        for entry in registry.list()
                    ),
                )
            ],
        ),
        *_metric(
            "mirage_jobs_running",
            "gauge",
            "Lines the server's API is running.",
            [("", sum(1 for job in jobs.list() if job.status in _RUNNING))],
        ),
        *_metric(
            "mirage_draining",
            "gauge",
            "1 while the server drains for shutdown, else 0.",
            [("", int(registry.draining))],
        ),
        *_metric(
            "mirage_http_responses_total",
            "counter",
            "Responses the server sent, by status code.",
            [
                (f'{{code="{code}"}}', count)
                for code, count in sorted(responses.items())
            ],
        ),
    ]
    resident = _resident_bytes()
    if resident is not None:
        lines += _metric(
            "process_resident_memory_bytes",
            "gauge",
            "Resident memory size in bytes.",
            [("", resident)],
        )
    return "\n".join(lines) + "\n"


def _metric(
    name: str, kind: str, about: str, samples: list[tuple[str, float]]
) -> list[str]:
    """One metric's lines: its help, its type and each sample, a whole
    number written bare as TypeScript writes it.

    Args:
        name (str): the metric's name.
        kind (str): gauge or counter.
        about (str): its help text.
        samples (list[tuple[str, float]]): each sample's labels, as
            written, and value.
    """
    return [
        f"# HELP {name} {about}",
        f"# TYPE {name} {kind}",
        *(
            f"{name}{labels} "
            f"{int(value) if value == int(value) else repr(value)}"
            for labels, value in samples
        ),
    ]


def _resident_bytes() -> int | None:
    """The process's resident memory, None where ``/proc`` does not
    report it."""
    try:
        with open("/proc/self/statm") as statm:
            pages = int(statm.read().split()[1])
    except OSError as exc:
        logger.debug("no resident memory to report: %s", exc)
        return None
    return pages * os.sysconf("SC_PAGE_SIZE")
