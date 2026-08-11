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

import argparse
import asyncio
import json
import sys
import urllib.error
import urllib.request

# 2026-01-01T00:00:00Z in unix nanoseconds. Spans carry client-chosen ids and
# timestamps, so every name and field the battery asserts on is fixed.
T0 = 1767225600000000000

TRACE_CHECKOUT = "a" * 31 + "1"
TRACE_SEARCH = "b" * 31 + "2"
# A distributed trace: three levels across two services, with an error leaf.
# The same trace id is therefore reachable under either service's directory.
TRACE_ORDER = "c" * 31 + "3"

POLL_ATTEMPTS = 60
POLL_DELAY = 1.0


def attr(key: str, value: str) -> dict:
    """Build an OTLP string attribute.

    Args:
        key (str): attribute key.
        value (str): attribute value.

    Returns:
        dict: OTLP KeyValue.
    """
    return {"key": key, "value": {"stringValue": value}}


def span(trace: str,
         span_id: str,
         name: str,
         start: int,
         duration: int,
         parent: str | None = None,
         attrs: list[dict] | None = None,
         status_code: int = 0) -> dict:
    """Build one OTLP span.

    Args:
        trace (str): 32 hex digit trace id.
        span_id (str): 16 hex digit span id.
        name (str): operation name.
        start (int): start time in unix nanoseconds.
        duration (int): span duration in nanoseconds.
        parent (str | None): parent span id for a child span.
        attrs (list[dict] | None): OTLP attributes.

    Returns:
        dict: OTLP span.
    """
    out = {
        "traceId": trace,
        "spanId": span_id,
        "name": name,
        "kind": "SPAN_KIND_SERVER",
        "startTimeUnixNano": str(start),
        "endTimeUnixNano": str(start + duration),
        "attributes": attrs or [],
        "status": {
            "code": status_code
        },
    }
    if parent is not None:
        out["parentSpanId"] = parent
    return out


PAYLOAD = {
    "resourceSpans": [
        {
            "resource": {
                "attributes": [attr("service.name", "checkout-api")]
            },
            "scopeSpans": [{
                "scope": {
                    "name": "mirage-integ"
                },
                "spans": [
                    span(TRACE_CHECKOUT,
                         "1" * 16,
                         "POST /checkout",
                         T0,
                         5_000_000,
                         attrs=[attr("http.method", "POST")]),
                    span(TRACE_CHECKOUT,
                         "2" * 16,
                         "charge-card",
                         T0 + 1_000_000,
                         2_000_000,
                         parent="1" * 16),
                ],
            }],
        },
        {
            "resource": {
                "attributes": [attr("service.name", "web-frontend")]
            },
            "scopeSpans": [{
                "scope": {
                    "name": "mirage-integ"
                },
                "spans": [
                    span(TRACE_ORDER, "4" * 16, "GET /cart",
                         T0 + 120_000_000_000, 9_000_000),
                ],
            }],
        },
        {
            "resource": {
                "attributes": [attr("service.name", "orders-api")]
            },
            "scopeSpans": [{
                "scope": {
                    "name": "mirage-integ"
                },
                "spans": [
                    span(TRACE_ORDER,
                         "5" * 16,
                         "POST /orders",
                         T0 + 120_001_000_000,
                         6_000_000,
                         parent="4" * 16),
                    span(TRACE_ORDER,
                         "6" * 16,
                         "db.query",
                         T0 + 120_002_000_000,
                         2_000_000,
                         parent="5" * 16,
                         attrs=[attr("db.system", "postgresql")],
                         status_code=2),
                ],
            }],
        },
        {
            "resource": {
                "attributes": [attr("service.name", "search-api")]
            },
            "scopeSpans": [{
                "scope": {
                    "name": "mirage-integ"
                },
                "spans": [
                    span(TRACE_SEARCH, "3" * 16, "GET /search",
                         T0 + 60_000_000_000, 3_000_000),
                ],
            }],
        },
    ]
}


def post_spans(host: str) -> None:
    """Push the fixture spans over OTLP/HTTP.

    Args:
        host (str): OTLP HTTP endpoint, e.g. http://localhost:4318.

    Raises:
        RuntimeError: the collector rejected the batch.
    """
    request = urllib.request.Request(
        f"{host.rstrip('/')}/v1/traces",
        data=json.dumps(PAYLOAD).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        if response.status != 200:
            raise RuntimeError(f"OTLP push failed: HTTP {response.status}")


def query(query_host: str, path: str) -> dict:
    """Call the Jaeger query API.

    Args:
        query_host (str): query API base URL.
        path (str): API path beginning with a slash.

    Returns:
        dict: decoded JSON body, or an empty dict when unreachable.
    """
    try:
        with urllib.request.urlopen(f"{query_host.rstrip('/')}{path}") as resp:
            body = json.loads(resp.read().decode())
            return body if isinstance(body, dict) else {}
    except (OSError, ValueError) as exc:
        # OSError, not just URLError: while the container boots,
        # docker-proxy accepts the connection and resets it mid-read,
        # which raises a raw ConnectionResetError past urllib.
        print(f"query not ready: {exc}", file=sys.stderr)
        return {}


async def wait_for_services(query_host: str) -> None:
    """Poll until both seeded services are queryable.

    Jaeger's in-memory store indexes asynchronously, so the services are not
    listed the moment the OTLP push returns.

    Args:
        query_host (str): query API base URL.

    Raises:
        RuntimeError: the services never appeared.
    """
    wanted = {"checkout-api", "search-api", "web-frontend", "orders-api"}
    for _ in range(POLL_ATTEMPTS):
        data = query(query_host, "/api/services").get("data")
        if isinstance(data, list) and wanted <= {str(s) for s in data}:
            return
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("seeded services never became queryable")


async def seed(query_host: str, otlp_host: str) -> None:
    """Bring a fresh jaeger container to the state the battery expects.

    Args:
        query_host (str): query API base URL.
        otlp_host (str): OTLP HTTP base URL.
    """
    for _ in range(POLL_ATTEMPTS):
        if query(query_host, "/api/services"):
            break
        await asyncio.sleep(POLL_DELAY)
    post_spans(otlp_host)
    await wait_for_services(query_host)
    print(f"JAEGER_URL={query_host}")


def main() -> None:
    """Parse arguments and seed the configured jaeger instance."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost:16686")
    parser.add_argument("--otlp", default="http://localhost:4318")
    args = parser.parse_args()
    asyncio.run(seed(args.host, args.otlp))


if __name__ == "__main__":
    main()
