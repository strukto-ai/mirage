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

import functools
import weakref
from collections.abc import Iterable

from opentelemetry import metrics
from opentelemetry.metrics import CallbackOptions, Counter, Meter, Observation

from mirage.execution.types import ExecutionStatus
from mirage.server.registry import WorkspaceRegistry

METER_NAME = "mirage.server"

_RUNNING = frozenset({ExecutionStatus.RUNNING, ExecutionStatus.STOPPING})
_registries: "weakref.WeakSet[WorkspaceRegistry]" = weakref.WeakSet()


def register_metrics(registry: WorkspaceRegistry) -> None:
    """Report ``registry`` through OpenTelemetry's global meter provider.

    Mirage records through the OpenTelemetry API only, so nothing is sent
    until the process sets up an SDK (``opentelemetry-instrument``, or a
    ``MeterProvider`` of its own); the exporter it picks decides where
    the numbers go. Mirrors TypeScript's ``registerMetrics``.

    Args:
        registry (WorkspaceRegistry): the app's workspaces.
    """
    _registries.add(registry)
    _instruments()


def refused(reason: str) -> None:
    """Count a request the server refused for one of its own limits.

    Args:
        reason (str): rate_limit, max_sessions, max_workspaces or
            draining.
    """
    _instruments().add(1, {"reason": reason})


@functools.cache
def _instruments() -> Counter:
    """The server's instruments, made once on the global meter provider;
    the refusal counter."""
    return _create(metrics.get_meter(METER_NAME))


def _create(meter: Meter) -> Counter:
    """Make the server's instruments on ``meter``.

    Args:
        meter (Meter): the meter.

    Returns:
        Counter: the refusal counter.
    """
    meter.create_observable_up_down_counter(
        "mirage.workspace.count",
        callbacks=[_workspaces],
        unit="{workspace}",
        description="Workspaces the server holds.",
    )
    meter.create_observable_up_down_counter(
        "mirage.workspace.limit",
        callbacks=[_limit],
        unit="{workspace}",
        description="The most workspaces the server holds at once.",
    )
    meter.create_observable_up_down_counter(
        "mirage.session.count",
        callbacks=[_sessions],
        unit="{session}",
        description="Sessions across the server's workspaces.",
    )
    meter.create_observable_up_down_counter(
        "mirage.job.running",
        callbacks=[_running],
        unit="{job}",
        description="Lines the server's API is running.",
    )
    meter.create_observable_gauge(
        "mirage.server.draining",
        callbacks=[_draining],
        unit="1",
        description="1 while the server drains for shutdown, else 0.",
    )
    return meter.create_counter(
        "mirage.request.refused",
        unit="{request}",
        description="Requests refused for a server limit, by reason.",
    )


def _workspaces(options: CallbackOptions) -> Iterable[Observation]:
    """The workspaces held.

    Args:
        options (CallbackOptions): the collection's options.
    """
    yield Observation(sum(len(registry) for registry in _registries))


def _limit(options: CallbackOptions) -> Iterable[Observation]:
    """The workspace cap, when one is set.

    Args:
        options (CallbackOptions): the collection's options.
    """
    caps = [r.max_workspaces for r in _registries if r.max_workspaces]
    if caps:
        yield Observation(sum(caps))


def _sessions(options: CallbackOptions) -> Iterable[Observation]:
    """The sessions across every workspace held.

    Args:
        options (CallbackOptions): the collection's options.
    """
    yield Observation(
        sum(
            len(entry.runner.ws.list_sessions())
            for registry in _registries
            for entry in registry.list()
        )
    )


def _running(options: CallbackOptions) -> Iterable[Observation]:
    """The lines the API is running.

    Args:
        options (CallbackOptions): the collection's options.
    """
    yield Observation(
        sum(
            1
            for registry in _registries
            for job in registry.jobs.list()
            if job.status in _RUNNING
        )
    )


def _draining(options: CallbackOptions) -> Iterable[Observation]:
    """1 while a server drains.

    Args:
        options (CallbackOptions): the collection's options.
    """
    yield Observation(int(any(r.draining for r in _registries)))
