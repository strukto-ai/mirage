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
import pytest
from httpx import ASGITransport, AsyncClient
from opentelemetry import context as otel_context
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)

from mirage.observe import observer as observer_module
from mirage.server import build_app
from mirage.server.trace import request_context

TRACE_ID = 0x4BF92F3577B34DA6A3CE929D0E0E4736
PARENT_ID = 0x00F067AA0BA902B7
TRACEPARENT = f"00-{TRACE_ID:032x}-{PARENT_ID:016x}-01"


def _span_of(ctx: otel_context.Context) -> trace.SpanContext:
    return trace.get_current_span(ctx).get_span_context()


def test_a_request_with_no_open_span_joins_the_callers_trace():
    joined = _span_of(request_context({"traceparent": TRACEPARENT}))
    assert (joined.trace_id, joined.span_id) == (TRACE_ID, PARENT_ID)
    assert joined.is_remote


def test_a_request_without_a_traceparent_starts_no_trace():
    assert not _span_of(request_context({})).is_valid


def test_a_request_with_a_bad_traceparent_starts_no_trace():
    assert not _span_of(request_context({"traceparent": "00-zz-01"})).is_valid


# An instrumentation library (FastAPI's, say) has already opened a span
# for the request under the caller's; the line goes under that span.
def test_an_open_span_wins_over_the_header():
    opened = trace.SpanContext(trace_id=0x1, span_id=0x2, is_remote=False)
    token = otel_context.attach(
        trace.set_span_in_context(trace.NonRecordingSpan(opened))
    )
    try:
        ctx = request_context({"traceparent": TRACEPARENT})
    finally:
        otel_context.detach(token)
    assert _span_of(ctx) == opened


# A shell request that carries a traceparent and no instrumentation puts
# its line's command span in the caller's trace, under the caller's span,
# across the hop to the workspace's own loop.
@pytest.mark.asyncio
async def test_a_shell_request_puts_its_line_in_the_callers_trace(
    monkeypatch,
):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(
        observer_module, "_tracer", lambda: provider.get_tracer("t")
    )
    app = build_app(idle_grace_seconds=10.0)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        r = await client.post(
            "/v1/workspaces",
            json={
                "config": {"mounts": {"/": {"vfs": "ram", "mode": "WRITE"}}}
            },
        )
        wid = r.json()["id"]
        r = await client.post(
            f"/v1/workspaces/{wid}/shell",
            json={"command": "echo hi"},
            headers={"traceparent": TRACEPARENT},
        )
        assert r.status_code == 200, r.text
        untraced = await client.post(
            f"/v1/workspaces/{wid}/shell", json={"command": "echo hi"}
        )
        assert untraced.status_code == 200, untraced.text
    traced, alone = (
        s for s in exporter.get_finished_spans() if s.name == "command"
    )
    assert traced.context.trace_id == TRACE_ID
    assert traced.parent is not None
    assert traced.parent.span_id == PARENT_ID
    assert alone.parent is None
    assert alone.context.trace_id != TRACE_ID
