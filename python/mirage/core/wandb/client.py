import base64
import json
from collections.abc import AsyncIterator, Mapping
from typing import Any, cast
from urllib.parse import SplitResult, urljoin, urlsplit

import aiohttp

from mirage.core.api.client import SessionPool, api_request
from mirage.core.wandb.config import WandbConfig
from mirage.core.wandb.errors import WandbAPIError
from mirage.core.wandb.queries import (FILE, FILES, HISTORY, HISTORY_KEYS,
                                       PROJECTS, RUN, RUNS)
from mirage.core.wandb.types import FileMetadata, Run, RunFile, RunVariables
from mirage.vfs.secrets import reveal_secret


def response_error(response: aiohttp.ClientResponse, text: str) -> Exception:
    if response.status in (401, 403):
        return PermissionError("W&B authentication or authorization failed")
    return WandbAPIError(f"W&B HTTP {response.status}")


def origin_key(url: SplitResult) -> tuple[str, str | None, int | None]:
    port = url.port
    if port is None:
        port = {"http": 80, "https": 443}.get(url.scheme)
    return url.scheme, url.hostname, port


class WandbClient:

    def __init__(self, config: WandbConfig, pool: SessionPool) -> None:
        self.config = config
        self.pool = pool

    def headers(self) -> dict[str, str]:
        key = reveal_secret(self.config.api_key)
        if not key:
            return {}
        token = base64.b64encode(f"api:{key}".encode()).decode()
        return {"Authorization": f"Basic {token}"}

    async def request(self, query: str,
                      variables: Mapping[str, Any]) -> dict[str, Any]:
        result = await api_request("POST",
                                   self.config.base_url.rstrip("/") +
                                   "/graphql",
                                   error_of=response_error,
                                   headers=self.headers(),
                                   json_body={
                                       "query": query,
                                       "variables": dict(variables)
                                   },
                                   session=self.pool)
        if result.get("errors"):
            raise WandbAPIError("W&B GraphQL request failed")
        if not isinstance(result.get("data"), dict):
            raise WandbAPIError("W&B response has no data")
        data: dict[str, Any] = result["data"]
        return data

    async def pages(self, query: str, variables: Mapping[str, Any],
                    keys: tuple[str, ...]) -> list[dict[str, Any]]:
        cursor = None
        seen: set[str] = set()
        rows: list[dict[str, Any]] = []
        for _ in range(self.config.max_pages):
            data = await self.request(query, {
                **variables, "cursor": cursor,
                "perPage": self.config.page_size
            })
            for key in keys:
                data = data[key]
                if data is None:
                    raise FileNotFoundError("W&B object not found")
            rows.extend(edge["node"] for edge in data["edges"])
            if not data["pageInfo"]["hasNextPage"]:
                return rows
            cursor = data["pageInfo"]["endCursor"]
            if not cursor or cursor in seen:
                raise WandbAPIError("W&B pagination did not advance")
            seen.add(cursor)
        raise WandbAPIError("W&B pagination limit exceeded")

    async def projects(self, entity: str) -> list[dict[str, Any]]:
        return await self.pages(PROJECTS, {"entity": entity}, ("models", ))

    async def runs(self, entity: str, project: str) -> list[dict[str, Any]]:
        return await self.pages(RUNS, {
            "entity": entity,
            "project": project
        }, ("project", "runs"))

    async def run(self, variables: RunVariables, query: str = RUN) -> Run:
        data = await self.request(query, variables)
        if data["project"] is None or data["project"]["run"] is None:
            raise FileNotFoundError("W&B run not found")
        run: Run = data["project"]["run"]
        return run

    async def files(self, variables: RunVariables) -> list[FileMetadata]:
        return cast(
            list[FileMetadata], await self.pages(FILES, variables,
                                                 ("project", "run", "files")))

    async def file(self, variables: RunVariables, name: str) -> RunFile | None:
        data = await self.request(FILE, {**variables, "names": [name]})
        if data["project"] is None or data["project"]["run"] is None:
            raise FileNotFoundError("W&B run not found")
        edges = data["project"]["run"]["files"]["edges"]
        return cast(RunFile, edges[0]["node"]) if edges else None

    async def history(
            self, variables: RunVariables) -> AsyncIterator[dict[str, Any]]:
        run = await self.run(variables, HISTORY_KEYS)
        last = (run.get("historyKeys") or {}).get("lastStep", -1)
        if not isinstance(last, int) or last < -1:
            raise WandbAPIError("W&B invalid last history step")
        size = self.config.page_size
        if (last + size) // size > self.config.max_pages:
            raise WandbAPIError("W&B history pagination limit exceeded")
        for start in range(0, last + 1, size):
            stop = min(start + size, last + 1)
            query_start = max(0, start - 1) if stop - start == 1 else start
            query_stop = max(stop, query_start + 2)
            data = await self.request(
                HISTORY, {
                    **variables, "minStep": query_start,
                    "maxStep": query_stop,
                    "pageSize": max(size, query_stop - query_start)
                })
            if data["project"] is None or data["project"]["run"] is None:
                raise FileNotFoundError("W&B run not found")
            for raw in data["project"]["run"]["history"]:
                row = json.loads(raw)
                if (query_start == start and query_stop == stop
                        or start <= row["_step"] < stop):
                    yield row

    async def download(self, url: str) -> AsyncIterator[bytes]:
        url = urljoin(self.config.base_url + "/", url)
        origin = urlsplit(self.config.base_url)
        target = urlsplit(url)
        if target.scheme not in (
                "http", "https") or target.username or target.password:
            raise WandbAPIError("W&B invalid download URL")
        headers = self.headers() if origin_key(origin) == origin_key(
            target) else {}
        async with self.pool.get().get(url, headers=headers) as response:
            if response.status >= 400:
                raise response_error(response, "")
            async for chunk in response.content.iter_chunked(65536):
                yield chunk
