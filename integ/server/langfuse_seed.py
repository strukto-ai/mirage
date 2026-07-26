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
import sys
from typing import Any

import aiohttp

PUBLIC_KEY = "pk-lf-mirage-integ"
SECRET_KEY = "sk-lf-mirage-integ"

# Traces are ingested with client-chosen ids and timestamps, so every VFS name
# the battery asserts on is fixed. Server-generated fields (createdAt, latency,
# htmlPath) still vary, which is why the cases project through jq instead of
# diffing whole documents.
TRACES = [
    {
        "event_id": "11111111-1111-4111-8111-111111111111",
        "id": "trace-alpha",
        "name": "checkout-flow",
        "userId": "user-ana",
        "sessionId": "session-one",
        "timestamp": "2026-01-01T00:00:00.000Z",
        "input": {"cart": "two items"},
        "output": {"status": "confirmed"},
        "tags": ["checkout", "prod"],
        "metadata": {"region": "eu-west"},
    },
    {
        "event_id": "22222222-2222-4222-8222-222222222222",
        "id": "trace-beta",
        "name": "search-query",
        "userId": "user-bo",
        "sessionId": "session-one",
        "timestamp": "2026-01-01T00:05:00.000Z",
        "input": {"query": "running shoes"},
        "output": {"hits": 12},
        "tags": ["search"],
        "metadata": {"region": "us-east"},
    },
    {
        "event_id": "33333333-3333-4333-8333-333333333333",
        "id": "trace-gamma",
        "name": "summarize-doc",
        "userId": "user-ana",
        "sessionId": "session-two",
        "timestamp": "2026-01-01T00:10:00.000Z",
        "input": {"doc": "quarterly report"},
        "output": {"summary": "revenue grew"},
        "tags": ["summarize", "prod"],
        "metadata": {"region": "eu-west"},
    },
]

# trace-alpha carries a span with a nested generation plus a score, so the
# `observations` and `scores` arrays in a rendered trace document are populated
# rather than empty.
OBSERVATIONS = [
    {
        "event_id": "44444444-4444-4444-8444-444444444444",
        "type": "span-create",
        "body": {
            "id": "obs-span-checkout",
            "traceId": "trace-alpha",
            "type": "SPAN",
            "name": "validate-cart",
            "startTime": "2026-01-01T00:00:01.000Z",
            "endTime": "2026-01-01T00:00:02.000Z",
            "input": {"items": 2},
            "output": {"valid": True},
            "level": "DEFAULT",
        },
    },
    {
        "event_id": "55555555-5555-4555-8555-555555555555",
        "type": "generation-create",
        "body": {
            "id": "obs-gen-summary",
            "traceId": "trace-alpha",
            "parentObservationId": "obs-span-checkout",
            "type": "GENERATION",
            "name": "describe-order",
            "startTime": "2026-01-01T00:00:01.200Z",
            "endTime": "2026-01-01T00:00:01.800Z",
            "model": "gpt-4o-mini",
            "input": [{"role": "user", "content": "describe the order"}],
            "output": {"content": "two items, confirmed"},
            "level": "DEFAULT",
        },
    },
]

SCORES = [
    {
        "event_id": "66666666-6666-4666-8666-666666666666",
        "type": "score-create",
        "body": {
            "id": "score-helpfulness",
            "traceId": "trace-alpha",
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

RUN_NAME = "run-alpha"
RUN_DATASET = "eval-basic"
RUN_ITEM_ID = "item-one"
RUN_TRACE_ID = "trace-alpha"

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
            status, _body = await request(session, host, "GET",
                                          "/api/public/health")
            if status == 200:
                return
        except aiohttp.ClientError as exc:
            print(f"health probe not ready: {exc}", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("langfuse did not become healthy in time")


async def existing_prompt_versions(session: aiohttp.ClientSession, host: str,
                                   name: str) -> set[int]:
    """List prompt versions already stored for a prompt name.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.
        name (str): prompt name.

    Returns:
        set[int]: versions present on the server.
    """
    status, body = await request(session, host, "GET",
                                "/api/public/v2/prompts", None,
                                {"name": name, "limit": "100"})
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
        status, body = await request(session, host, "POST",
                                     "/api/public/v2/prompts", payload)
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
        status, body = await request(session, host, "POST",
                                     "/api/public/v2/datasets", {"name": name})
        if status not in (200, 201, 409):
            raise RuntimeError(
                f"dataset {name} create failed: {status} {body}")


async def seed_dataset_items(session: aiohttp.ClientSession,
                             host: str) -> None:
    """Upsert the fixture dataset items by their client-chosen ids.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server rejected a dataset item.
    """
    for item in DATASET_ITEMS:
        status, body = await request(session, host, "POST",
                                     "/api/public/dataset-items", item)
        if status not in (200, 201):
            raise RuntimeError(
                f"dataset item {item['id']} failed: {status} {body}")


async def ingest_traces(session: aiohttp.ClientSession, host: str) -> None:
    """Push the fixture traces through the async ingestion endpoint.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the ingestion batch was rejected.
    """
    batch = []
    for spec in TRACES:
        body = {k: v for k, v in spec.items() if k != "event_id"}
        batch.append({
            "id": spec["event_id"],
            "type": "trace-create",
            "timestamp": spec["timestamp"],
            "body": body,
        })
    for extra in (*OBSERVATIONS, *SCORES):
        batch.append({
            "id": extra["event_id"],
            "type": extra["type"],
            "timestamp": "2026-01-01T00:00:00.000Z",
            "body": extra["body"],
        })
    status, body = await request(session, host, "POST",
                                "/api/public/ingestion", {"batch": batch})
    if status not in (200, 201, 207):
        raise RuntimeError(f"ingestion failed: {status} {body}")
    if isinstance(body, dict) and body.get("errors"):
        raise RuntimeError(f"ingestion reported errors: {body['errors']}")


async def wait_for_traces(session: aiohttp.ClientSession, host: str) -> None:
    """Poll until every ingested trace is queryable.

    Ingestion is queued through Redis and written to ClickHouse by the worker
    container, so the traces are not readable the moment the POST returns.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the traces never landed.
    """
    wanted = {str(spec["id"]) for spec in TRACES}
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(session, host, "GET",
                                     "/api/public/traces", None,
                                     {"limit": "100"})
        if status == 200 and isinstance(body, dict):
            have = {row.get("id") for row in body.get("data", [])}
            missing = wanted - have
            if not missing:
                return
            print(f"waiting for traces: {sorted(missing)}", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("ingested traces never became queryable")


async def wait_for_observations(session: aiohttp.ClientSession,
                                host: str) -> None:
    """Poll until the ingested observations and score reach the trace.

    Observations travel the same async queue as traces but are joined onto the
    trace document later, so a trace can be readable while still reporting an
    empty `observations` array.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the observations never appeared on the trace.
    """
    wanted = {str(o["body"]["id"]) for o in OBSERVATIONS}
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(session, host, "GET",
                                     "/api/public/traces/trace-alpha")
        if status == 200 and isinstance(body, dict):
            have = {
                row.get("id")
                for row in body.get("observations", [])
                if isinstance(row, dict)
            }
            if wanted <= have and body.get("scores"):
                return
            print(f"waiting for observations: {sorted(wanted - have)}",
                  file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("ingested observations never reached the trace")


async def seed_dataset_run(session: aiohttp.ClientSession, host: str) -> None:
    """Link a dataset item to an ingested trace, creating the fixture run.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the server rejected the dataset run item.
    """
    status, body = await request(
        session, host, "POST", "/api/public/dataset-run-items", {
            "runName": RUN_NAME,
            "datasetItemId": RUN_ITEM_ID,
            "traceId": RUN_TRACE_ID,
        })
    if status not in (200, 201):
        raise RuntimeError(f"dataset run item failed: {status} {body}")


async def wait_for_run(session: aiohttp.ClientSession, host: str) -> None:
    """Poll until the fixture dataset run is listed for its dataset.

    Args:
        session (aiohttp.ClientSession): shared HTTP session.
        host (str): Langfuse base URL.

    Raises:
        RuntimeError: the run never appeared.
    """
    path = f"/api/public/datasets/{RUN_DATASET}/runs"
    for _ in range(POLL_ATTEMPTS):
        status, body = await request(session, host, "GET", path, None,
                                     {"limit": "100"})
        if status == 200 and isinstance(body, dict):
            names = {row.get("name") for row in body.get("data", [])}
            if RUN_NAME in names:
                return
            print(f"waiting for dataset run {RUN_NAME}", file=sys.stderr)
        await asyncio.sleep(POLL_DELAY)
    raise RuntimeError("dataset run never became queryable")


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
        await wait_for_observations(session, host)
        await seed_dataset_run(session, host)
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
