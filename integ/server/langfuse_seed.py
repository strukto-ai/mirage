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
import base64
import json
import sys
from datetime import datetime
from typing import Any

import aiohttp

PUBLIC_KEY = "pk-lf-mirage-integ"
SECRET_KEY = "sk-lf-mirage-integ"

# Langfuse v4 keeps no trace entity: a trace is its OpenTelemetry spans, and
# the root span carries the trace's name, user, session, tags and metadata.
# Ids and timestamps are client-chosen, so every VFS name the battery asserts
# on is fixed. createdAt/updatedAt vary between seeds. Model-price
# initialization can race the web container's schema migrations, so the
# generation's cost fields may or may not be populated; the battery checks
# du's shape and sum against reads rather than a fixed size.
TRACE_ALPHA = "a1" * 16
TRACE_BETA = "b2" * 16
TRACE_GAMMA = "c3" * 16

TRACES = [
    {
        "id": TRACE_ALPHA,
        "root": "a1a1a1a1a1a1a100",
        "name": "checkout-flow",
        "userId": "user-ana",
        "sessionId": "session-one",
        "start": "2026-01-01T00:00:00.000Z",
        "end": "2026-01-01T00:00:03.000Z",
        "input": {"cart": "two items"},
        "output": {"status": "confirmed"},
        "tags": ["checkout", "prod"],
        "metadata": {"region": "eu-west"},
    },
    {
        "id": TRACE_BETA,
        "root": "b2b2b2b2b2b2b200",
        "name": "search-query",
        "userId": "user-bo",
        "sessionId": "session-one",
        "start": "2026-01-01T00:05:00.000Z",
        "end": "2026-01-01T00:05:01.000Z",
        "input": {"query": "running shoes"},
        "output": {"hits": 12},
        "tags": ["search"],
        "metadata": {"region": "us-east"},
    },
    {
        "id": TRACE_GAMMA,
        "root": "c3c3c3c3c3c3c300",
        "name": "summarize-doc",
        "userId": "user-ana",
        "sessionId": "session-two",
        "start": "2026-01-01T00:10:00.000Z",
        "end": "2026-01-01T00:10:01.000Z",
        "input": {"doc": "quarterly report"},
        "output": {"summary": "revenue grew"},
        "tags": ["summarize", "prod"],
        "metadata": {"region": "eu-west"},
    },
]

# TRACE_ALPHA carries a span with a nested generation plus a score, so the
# `observations` and `scores` arrays in a rendered trace document are populated
# rather than empty.
OBSERVATIONS = [
    {
        "traceId": TRACE_ALPHA,
        "id": "a1a1a1a1a1a1a101",
        "parent": "a1a1a1a1a1a1a100",
        "type": "span",
        "name": "validate-cart",
        "start": "2026-01-01T00:00:01.000Z",
        "end": "2026-01-01T00:00:02.000Z",
        "input": {"items": 2},
        "output": {"valid": True},
    },
    {
        "traceId": TRACE_ALPHA,
        "id": "a1a1a1a1a1a1a102",
        "parent": "a1a1a1a1a1a1a101",
        "type": "generation",
        "name": "describe-order",
        "start": "2026-01-01T00:00:01.200Z",
        "end": "2026-01-01T00:00:01.800Z",
        "model": "gpt-4o-mini",
        "input": [{"role": "user", "content": "describe the order"}],
        "output": {"content": "two items, confirmed"},
    },
]

# Score events are the one kind v4's ingestion endpoint still accepts.
SCORES = [
    {
        "event_id": "66666666-6666-4666-8666-666666666666",
        "type": "score-create",
        "body": {
            "id": "score-helpfulness",
            "traceId": TRACE_ALPHA,
            "name": "helpfulness",
            "value": 0.75,
            "dataType": "NUMERIC",
            "comment": "clear summary",
        },
    },
]

PROMPTS = [
    {
        "name": "greeting",
        "type": "text",
        "prompt": "Hello {{name}}, welcome aboard.",
        "labels": ["production"],
        "version": 1,
    },
    {
        "name": "greeting",
        "type": "text",
        "prompt": "Hi {{name}}, glad you are here.",
        "labels": ["latest"],
        "version": 2,
    },
    {
        "name": "qa-template",
        "type": "chat",
        "prompt": [
            {"role": "system", "content": "Answer briefly."},
            {"role": "user", "content": "{{question}}"},
        ],
        "labels": ["production"],
        "version": 1,
    },
]

DATASETS = ["eval-basic", "eval-empty"]

DATASET_ITEMS = [
    {
        "id": "item-one",
        "datasetName": "eval-basic",
        "input": {"question": "capital of france"},
        "expectedOutput": {"answer": "paris"},
    },
    {
        "id": "item-two",
        "datasetName": "eval-basic",
        "input": {"question": "capital of japan"},
        "expectedOutput": {"answer": "tokyo"},
    },
]


# The fixture run is a v4 experiment over eval-basic: TRACE_ALPHA's root span
# carries the experiment attributes the SDK's run_experiment sets.
RUN_ID = "e5e5e5e5e5e5e5e5"
RUN_NAME = "run-alpha"
RUN_DATASET = "eval-basic"
RUN_ITEM_ID = "item-one"
RUN_FROM = "2026-01-01T00:00:00.000Z"

POLL_ATTEMPTS = 120
POLL_DELAY = 2.0


def auth_header() -> dict[str, str]:
    """Build the HTTP Basic header Langfuse's public API expects.

    Returns:
        dict[str, str]: Authorization header for the seeded project keys.
    """
    raw = f"{PUBLIC_KEY}:{SECRET_KEY}".encode()
    return {"Authorization": f"Basic {base64.b64encode(raw).decode()}"}


async def request(
    session: aiohttp.ClientSession,
    host: str,
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    params: dict[str, str] | None = None,
) -> tuple[int, Any]:
    """Call the Langfuse public API and return status plus decoded body.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.
        method (str): HTTP verb.
        path (str): API path beginning with a slash.
        payload (dict[str, Any] | None): JSON request body.
        params (dict[str, str] | None): query string arguments.

    Returns:
        tuple[int, Any]: response status and parsed JSON, or raw text when the
        body is not JSON.
    """
    url = f"{host.rstrip('/')}{path}"
    async with session.request(
        method,
        url,
        json=payload,
        params=params,
        headers=auth_header(),
    ) as response:
        text = await response.text()
        try:
            body = await response.json(content_type=None)
        except (aiohttp.ContentTypeError, ValueError):
            body = text
        return response.status, body


async def wait_healthy(session: aiohttp.ClientSession, host: str) -> None:
    """Block until the Langfuse web container answers its health probe.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server never became healthy.
    """
    for _ in range(POLL_ATTEMPTS):
        try:
            status, _body = await request(
                session, host, "GET", "/api/public/health"
            )
            if status == 200:
                return
        except aiohttp.ClientError as exc:
            print(f"health probe not ready: {exc}", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("langfuse did not become healthy in time")


async def existing_prompt_versions(
    session: aiohttp.ClientSession, host: str, name: str
) -> set[int]:
    """List prompt versions already stored for a prompt name.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.
        name (str): prompt name.

    Returns:
        set[int]: versions present on the server.
    """
    status, body = await request(
        session,
        host,
        "GET",
        "/api/public/v2/prompts",
        None,
        {"name": name, "limit": "100"},
    )
    if status != 200 or not isinstance(body, dict):
        return set()
    # The list endpoint returns PromptMeta rows, which carry every version in a
    # `versions` array; there is no scalar `version` to read here.
    found: set[int] = set()
    for row in body.get("data", []):
        for version in row.get("versions", []):
            found.add(int(version))
    return found


async def seed_prompts(session: aiohttp.ClientSession, host: str) -> None:
    """Create the fixture prompt versions that are not already present.

    Creating a prompt with an existing name appends a new version, so this
    skips versions the server already has and keeps re-runs deterministic.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server rejected a prompt creation.
    """
    seen: dict[str, set[int]] = {}
    for spec in PROMPTS:
        name = str(spec["name"])
        if name not in seen:
            seen[name] = await existing_prompt_versions(session, host, name)
        if int(spec["version"]) in seen[name]:
            print(f"prompt {name} v{spec['version']} already seeded")
            continue
        payload = {
            "name": name,
            "type": spec["type"],
            "prompt": spec["prompt"],
            "labels": spec["labels"],
        }
        status, body = await request(
            session, host, "POST", "/api/public/v2/prompts", payload
        )
        if status not in (200, 201):
            raise RuntimeError(f"prompt {name} create failed: {status} {body}")
        seen[name].add(int(spec["version"]))


async def seed_datasets(session: aiohttp.ClientSession, host: str) -> None:
    """Create the fixture datasets, tolerating ones that already exist.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server rejected a dataset creation.
    """
    for name in DATASETS:
        status, body = await request(
            session, host, "POST", "/api/public/v2/datasets", {"name": name}
        )
        if status not in (200, 201, 409):
            raise RuntimeError(
                f"dataset {name} create failed: {status} {body}"
            )


async def seed_dataset_items(
    session: aiohttp.ClientSession, host: str
) -> None:
    """Upsert the fixture dataset items by their client-chosen ids.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server rejected a dataset item.
    """
    for item in DATASET_ITEMS:
        status, body = await request(
            session, host, "POST", "/api/public/dataset-items", item
        )
        if status not in (200, 201):
            raise RuntimeError(
                f"dataset item {item['id']} failed: {status} {body}"
            )


async def dataset_id(
    session: aiohttp.ClientSession, host: str, name: str
) -> str:
    """Look up the server-assigned id of a fixture dataset.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.
        name (str): dataset name.

    Returns:
        str: the dataset id.

    Raises:
        RuntimeError: the dataset is missing.
    """
    status, body = await request(
        session, host, "GET", f"/api/public/v2/datasets/{name}"
    )
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"dataset {name} lookup failed: {status} {body}")
    return str(body["id"])


def nanos(stamp: str) -> str:
    """Convert an ISO timestamp to OTLP unix nanoseconds.

    Args:
        stamp (str): ISO 8601 timestamp with a Z suffix.

    Returns:
        str: unix nanoseconds as a decimal string.
    """
    moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return str(int(moment.timestamp() * 1000) * 1_000_000)


def attr(key: str, value: str | list[str]) -> dict[str, Any]:
    """Build an OTLP string or string-array attribute.

    Args:
        key (str): attribute key.
        value (str | list[str]): attribute value.

    Returns:
        dict[str, Any]: OTLP KeyValue.
    """
    if isinstance(value, list):
        items = [{"stringValue": item} for item in value]
        return {"key": key, "value": {"arrayValue": {"values": items}}}
    return {"key": key, "value": {"stringValue": value}}


def span(
    trace_id: str,
    span_id: str,
    name: str,
    start: str,
    end: str,
    attrs: list[dict[str, Any]],
    parent: str | None = None,
) -> dict[str, Any]:
    """Build one OTLP span.

    Args:
        trace_id (str): 32 hex digit trace id.
        span_id (str): 16 hex digit span id.
        name (str): span name.
        start (str): ISO start time.
        end (str): ISO end time.
        attrs (list[dict[str, Any]]): OTLP attributes.
        parent (str | None): parent span id for a child span.

    Returns:
        dict[str, Any]: OTLP span.
    """
    out: dict[str, Any] = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": 1,
        "startTimeUnixNano": nanos(start),
        "endTimeUnixNano": nanos(end),
        "attributes": attrs,
        "status": {},
    }
    if parent is not None:
        out["parentSpanId"] = parent
    return out


def root_span(spec: dict[str, Any], run_dataset_id: str) -> dict[str, Any]:
    """Build a trace's root span with its trace-level attributes.

    Args:
        spec (dict[str, Any]): one TRACES entry.
        run_dataset_id (str): id of the dataset the fixture run covers.

    Returns:
        dict[str, Any]: OTLP span.
    """
    attrs = [
        attr("langfuse.trace.name", spec["name"]),
        attr("langfuse.user.id", spec["userId"]),
        attr("langfuse.session.id", spec["sessionId"]),
        attr("langfuse.trace.tags", spec["tags"]),
        attr("langfuse.observation.type", "span"),
        attr("langfuse.observation.input", json.dumps(spec["input"])),
        attr("langfuse.observation.output", json.dumps(spec["output"])),
    ]
    attrs.extend(
        attr(f"langfuse.trace.metadata.{key}", value)
        for key, value in spec["metadata"].items()
    )
    if spec["id"] == TRACE_ALPHA:
        attrs.extend(
            [
                attr("langfuse.experiment.id", RUN_ID),
                attr("langfuse.experiment.name", RUN_NAME),
                attr("langfuse.experiment.dataset.id", run_dataset_id),
                attr("langfuse.experiment.item.id", RUN_ITEM_ID),
                attr(
                    "langfuse.experiment.item.root_observation_id",
                    spec["root"],
                ),
            ]
        )
    return span(
        spec["id"],
        spec["root"],
        spec["name"],
        spec["start"],
        spec["end"],
        attrs,
    )


def child_span(spec: dict[str, Any]) -> dict[str, Any]:
    """Build a nested observation's span.

    Args:
        spec (dict[str, Any]): one OBSERVATIONS entry.

    Returns:
        dict[str, Any]: OTLP span.
    """
    attrs = [
        attr("langfuse.observation.type", spec["type"]),
        attr("langfuse.observation.input", json.dumps(spec["input"])),
        attr("langfuse.observation.output", json.dumps(spec["output"])),
    ]
    if "model" in spec:
        attrs.append(attr("langfuse.observation.model.name", spec["model"]))
    return span(
        spec["traceId"],
        spec["id"],
        spec["name"],
        spec["start"],
        spec["end"],
        attrs,
        spec["parent"],
    )


async def ingest_traces(session: aiohttp.ClientSession, host: str) -> None:
    """Push the fixture spans over OTLP and the score through ingestion.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: a batch was rejected.
    """
    run_dataset_id = await dataset_id(session, host, RUN_DATASET)
    spans = [root_span(spec, run_dataset_id) for spec in TRACES]
    spans.extend(child_span(spec) for spec in OBSERVATIONS)
    payload = {
        "resourceSpans": [
            {
                "resource": {"attributes": [attr("service.name", "mirage")]},
                "scopeSpans": [
                    {"scope": {"name": "mirage-integ"}, "spans": spans}
                ],
            }
        ]
    }
    url = f"{host.rstrip('/')}/api/public/otel/v1/traces"
    headers = {**auth_header(), "x-langfuse-ingestion-version": "4"}
    async with session.post(url, json=payload, headers=headers) as response:
        if response.status not in (200, 201, 202):
            raise RuntimeError(
                f"otlp push failed: {response.status} {await response.text()}"
            )
    batch = [
        {
            "id": score["event_id"],
            "type": score["type"],
            "timestamp": "2026-01-01T00:00:00.000Z",
            "body": score["body"],
        }
        for score in SCORES
    ]
    status, body = await request(
        session, host, "POST", "/api/public/ingestion", {"batch": batch}
    )
    if status not in (200, 201, 207):
        raise RuntimeError(f"ingestion failed: {status} {body}")
    if isinstance(body, dict) and body.get("errors"):
        raise RuntimeError(f"ingestion reported errors: {body['errors']}")


async def wait_for_traces(session: aiohttp.ClientSession, host: str) -> None:
    """Poll until every ingested observation is queryable.

    OTLP spans are queued through Redis and written to ClickHouse by the
    worker container, so they are not readable the moment the POST returns.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the observations never landed.
    """
    wanted = {str(spec["root"]) for spec in TRACES}
    wanted.update(str(spec["id"]) for spec in OBSERVATIONS)
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(
            session,
            host,
            "GET",
            "/api/public/v2/observations",
            None,
            {"limit": "100"},
        )
        if status == 200 and isinstance(body, dict):
            have = {row.get("id") for row in body.get("data", [])}
            missing = wanted - have
            if not missing:
                return
            print(
                f"waiting for observations: {sorted(missing)}", file=sys.stderr
            )
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("ingested observations never became queryable")


async def wait_for_scores(session: aiohttp.ClientSession, host: str) -> None:
    """Poll until the fixture score is queryable.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the score never landed.
    """
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(
            session,
            host,
            "GET",
            "/api/public/v3/scores",
            None,
            {"traceId": TRACE_ALPHA},
        )
        if status == 200 and isinstance(body, dict) and body.get("data"):
            return
        print("waiting for scores", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("ingested score never became queryable")


async def wait_for_run(session: aiohttp.ClientSession, host: str) -> None:
    """Poll until the fixture experiment is listed.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the experiment never appeared.
    """
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(
            session,
            host,
            "GET",
            "/api/public/experiments",
            None,
            {"fromStartTime": RUN_FROM, "name": RUN_NAME},
        )
        if status == 200 and isinstance(body, dict) and body.get("data"):
            return
        print(f"waiting for experiment {RUN_NAME}", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("experiment never became queryable")


async def seed(host: str) -> None:
    """Bring a fresh Langfuse instance to the state the battery expects.

    Args:
        host (str): Langfuse base URL.
    """
    async with aiohttp.ClientSession() as session:
        await wait_healthy(session, host)
        await seed_prompts(session, host)
        await seed_datasets(session, host)
        await seed_dataset_items(session, host)
        await ingest_traces(session, host)
        await wait_for_traces(session, host)
        await wait_for_scores(session, host)
        await wait_for_run(session, host)
    print(f"LANGFUSE_URL={host}")


def main() -> None:
    """Parse arguments and seed the configured Langfuse instance."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost:3000")
    args = parser.parse_args()
    asyncio.run(seed(args.host))


if __name__ == "__main__":
    main()
