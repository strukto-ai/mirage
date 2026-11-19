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

from opentelemetry import metrics
from opentelemetry.metrics import Meter

from mirage.observe.constants import DURATION_BUCKETS, METER_NAME
from mirage.observe.record import OpRecord
from mirage.observe.types import Instruments


def line_ended(exit_code: int, duration_ms: int) -> None:
    """Count a typed line that ended in ``mirage.shell.duration``, under
    its exit code.

    Args:
        exit_code (int): how it ended.
        duration_ms (int): how long it ran, in milliseconds.
    """
    _instruments().shell_duration.record(
        duration_ms / 1000, {"mirage.exit_code": exit_code}
    )


def call_made(rec: OpRecord) -> None:
    """Count a call made to a mount, in or out of a line: its length in
    ``mirage.vfs.duration`` and the bytes it moved in ``mirage.vfs.io``,
    under the call and the backend that served it.

    Args:
        rec (OpRecord): the call.
    """
    attributes = {"mirage.vfs.op": rec.op, "mirage.vfs.source": rec.source}
    held = _instruments()
    held.vfs_duration.record(rec.duration_ms / 1000, attributes)
    if rec.bytes > 0:
        held.vfs_io.add(rec.bytes, attributes)


@functools.cache
def _instruments() -> Instruments:
    """The observer's instruments, made once on the global meter
    provider: a no-op until the process sets up an OpenTelemetry SDK,
    whose exporter picks the backend."""
    return _create(metrics.get_meter(METER_NAME))


def _create(meter: Meter) -> Instruments:
    """Make the observer's instruments on ``meter``.

    Args:
        meter (Meter): the meter.
    """
    return Instruments(
        shell_duration=meter.create_histogram(
            "mirage.shell.duration",
            unit="s",
            description="How long typed lines ran, by exit code.",
            explicit_bucket_boundaries_advisory=DURATION_BUCKETS,
        ),
        vfs_duration=meter.create_histogram(
            "mirage.vfs.duration",
            unit="s",
            description="How long calls to mounts took, by call and backend.",
            explicit_bucket_boundaries_advisory=DURATION_BUCKETS,
        ),
        vfs_io=meter.create_counter(
            "mirage.vfs.io",
            unit="By",
            description="Bytes calls to mounts moved, by call and backend.",
        ),
    )
