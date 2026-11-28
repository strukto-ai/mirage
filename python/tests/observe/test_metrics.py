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
import asyncio

import pytest
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader

from mirage import MountMode, Workspace
from mirage.observe import metrics as metrics_module
from mirage.observe.metrics import _create
from mirage.vfs.ram import RAMVFS


def _points(
    reader: InMemoryMetricReader, name: str
) -> dict[tuple[tuple[str, str | int], ...], tuple[int | float, int | None]]:
    """One metric's points, by their attributes: a histogram's sum and
    count, a counter's value."""
    data = reader.get_metrics_data()
    out: dict[
        tuple[tuple[str, str | int], ...], tuple[int | float, int | None]
    ] = {}
    for resource in data.resource_metrics if data is not None else []:
        for scope in resource.scope_metrics:
            for metric in scope.metrics:
                if metric.name != name:
                    continue
                for point in metric.data.data_points:
                    key = tuple(sorted(point.attributes.items()))
                    count = getattr(point, "count", None)
                    value = point.sum if count is not None else point.value
                    out[key] = (value, count)
    return out


@pytest.fixture
def reader(monkeypatch) -> InMemoryMetricReader:
    """Send the observer's metrics to memory, to read back."""
    reader = InMemoryMetricReader()
    held = _create(MeterProvider(metric_readers=[reader]).get_meter("t"))
    monkeypatch.setattr(metrics_module, "_instruments", lambda: held)
    return reader


# Each typed line counts once in mirage.shell.duration under its exit
# code, and each call it makes to a mount in mirage.vfs.duration and,
# when it moved bytes, mirage.vfs.io, under the call and the backend.
@pytest.mark.asyncio
async def test_lines_and_their_mount_calls_count_by_low_cardinality_labels(
    reader,
):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo hi > /data/a.txt")
        await ws.shell("cat /data/a.txt")
        await ws.shell("cat /data/missing.txt")
    finally:
        await ws.close()
    lines = _points(reader, "mirage.shell.duration")
    assert {key: count for key, (_, count) in lines.items()} == {
        (("mirage.exit_code", 0),): 2,
        (("mirage.exit_code", 1),): 1,
    }
    io = _points(reader, "mirage.vfs.io")
    assert (
        io[(("mirage.vfs.op", "write"), ("mirage.vfs.source", "ram"))][0] == 3
    )
    assert (
        io[(("mirage.vfs.op", "read"), ("mirage.vfs.source", "ram"))][0] == 3
    )
    calls = _points(reader, "mirage.vfs.duration")
    assert (("mirage.vfs.op", "read"), ("mirage.vfs.source", "ram")) in calls
    assert all(
        {name for name, _ in key} == {"mirage.vfs.op", "mirage.vfs.source"}
        for key in calls
    )


# A call made to a mount outside any line counts too.
@pytest.mark.asyncio
async def test_a_call_outside_a_line_counts(reader):
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell("echo hello > /data/b.txt")
        before = _points(reader, "mirage.vfs.io")
        key = (("mirage.vfs.op", "read"), ("mirage.vfs.source", "ram"))
        await ws.vfs.read("/data/b.txt")
        await asyncio.sleep(0)
    finally:
        await ws.close()
    after = _points(reader, "mirage.vfs.io")
    assert after[key][0] - before.get(key, (0, None))[0] == 6
