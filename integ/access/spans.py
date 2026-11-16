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

"""The spans a deployed server sends, for checking whose trace a line joined.

serve.py sets up a tracer provider when ACCESS_SPANS names a file,
and each span is appended there as one JSON line as it ends, with its
name, ids, parent and mirage.command, for run.py to read while the
server runs. spans.ts is the TypeScript twin.
"""

import json
from collections.abc import Sequence
from pathlib import Path

from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import (
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)

SPANS_ENV = "ACCESS_SPANS"


class SpanFile(SpanExporter):
    """Append each ended span to a file as a JSON line.

    Args:
        path (Path): the file.
    """

    def __init__(self, path: Path) -> None:
        self.path = path

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        with self.path.open("a") as out:
            for span in spans:
                own = span.get_span_context()
                assert own is not None
                attributes = span.attributes or {}
                record = {
                    "name": span.name,
                    "trace_id": f"{own.trace_id:032x}",
                    "span_id": f"{own.span_id:016x}",
                    "parent_id": (
                        f"{span.parent.span_id:016x}" if span.parent else None
                    ),
                    "command": attributes.get("mirage.command"),
                }
                out.write(json.dumps(record) + "\n")
        return SpanExportResult.SUCCESS


def record_spans(path: Path) -> None:
    """Send every span this process starts to ``path``.

    Args:
        path (Path): the file the spans are appended to.
    """
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(SpanFile(path)))
    trace.set_tracer_provider(provider)
