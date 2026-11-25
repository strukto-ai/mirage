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


import base64
import binascii
import json
import os
from collections.abc import AsyncGenerator, AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from mirage.machine.kosa8.constants import (
    API_KEY_ENV,
    API_URL_ENV,
    DEFAULT_API_URL,
    REQUEST_TIMEOUT_SECONDS,
    STREAM_QUIET_SECONDS,
)
from mirage.types import JsonValue


class Kosa8ApiError(Exception):
    """A refusal kosa8 Cloud answered with.

    Args:
        status (int): the HTTP status.
        code (str): kosa8's error code (``not_found``, ``not_running``).
        message (str): what kosa8 said.
    """

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{message} ({status} {code})")
        self.status = status
        self.code = code


class Kosa8StreamCut(Exception):
    """An exec's stream that ended or broke before the command's exit
    came."""


@dataclass(frozen=True, slots=True)
class ExecFrame:
    """One piece of a streamed exec: output, or the command's exit.

    Args:
        stream (str | None): ``stdout`` or ``stderr`` for output.
        data (bytes): the output's bytes.
        exit_code (int | None): the exit status, on the last frame.
    """

    stream: str | None = None
    data: bytes = b""
    exit_code: int | None = None


def parse_frame(line: bytes) -> ExecFrame | None:
    """The frame one NDJSON line holds; None for a heartbeat.

    Args:
        line (bytes): one line of the stream.

    Raises:
        Kosa8StreamCut: the line is not a frame, or the command failed
            without an exit status.
    """
    try:
        raw = json.loads(line)
        if raw.get("done"):
            code = raw.get("exit")
            if not isinstance(code, int) or isinstance(code, bool):
                raise Kosa8StreamCut(
                    str(
                        raw.get("error") or "the command ended without an exit"
                    )
                )
            return ExecFrame(exit_code=code)
        if "data" not in raw:
            return None
        return ExecFrame(
            stream=str(raw.get("stream") or "stdout"),
            data=base64.b64decode(raw["data"], validate=True),
        )
    except (ValueError, AttributeError, binascii.Error) as exc:
        raise Kosa8StreamCut(
            f"kosa8 sent a frame it cannot read: {exc}"
        ) from exc


class Kosa8Api:
    """The part of kosa8 Cloud's REST API a machine uses, over httpx.

    Args:
        api_key (str | None): the API key; None reads KOSA8_API_KEY.
        api_url (str | None): the API's address; None reads
            KOSA8_CLOUD_URL, then ``DEFAULT_API_URL``.
        transport (httpx.AsyncBaseTransport | None): the transport, for
            tests; None is the network.

    Raises:
        ValueError: no API key is set.
    """

    def __init__(
        self,
        api_key: str | None,
        api_url: str | None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        key = (api_key or os.environ.get(API_KEY_ENV, "")).strip()
        if not key:
            raise ValueError(
                f"kosa8: no API key; set {API_KEY_ENV} or the machine's api_key"
            )
        url = api_url or os.environ.get(API_URL_ENV) or DEFAULT_API_URL
        self._client = httpx.AsyncClient(
            base_url=url.rstrip("/"),
            headers={
                "Authorization": f"Bearer {key}",
                "User-Agent": "mirage-kosa8",
            },
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS),
            transport=transport,
        )

    @staticmethod
    def _path(sandbox_id: str, suffix: str = "") -> str:
        return f"/v1/sandboxes/{quote(sandbox_id, safe='')}{suffix}"

    @staticmethod
    async def _refusal(response: httpx.Response) -> Kosa8ApiError:
        """The error a refused answer carries.

        Args:
            response (httpx.Response): the answer, read or not.
        """
        body = await response.aread()
        try:
            data = json.loads(body)
        except ValueError:
            data = {}
        if not isinstance(data, dict):
            data = {}
        return Kosa8ApiError(
            response.status_code,
            str(data.get("code") or data.get("error") or "error"),
            str(data.get("message") or body[:300].decode(errors="replace")),
        )

    async def _call(
        self,
        method: str,
        path: str,
        body: Mapping[str, JsonValue] | None = None,
        params: Mapping[str, str] | None = None,
    ) -> dict[str, JsonValue]:
        response = await self._client.request(
            method, path, json=body, params=params
        )
        if response.is_error:
            raise await self._refusal(response)
        if not response.content:
            return {}
        data = response.json()
        return data if isinstance(data, dict) else {}

    async def create(
        self, body: Mapping[str, JsonValue]
    ) -> dict[str, JsonValue]:
        """Start a sandbox and return it once kosa8 has it.

        Args:
            body (Mapping[str, JsonValue]): the create's fields.
        """
        sandbox = (await self._call("POST", "/v1/sandboxes", body))["sandbox"]
        return sandbox if isinstance(sandbox, dict) else {}

    async def get(self, sandbox_id: str) -> dict[str, JsonValue]:
        """The sandbox as kosa8 sees it.

        Args:
            sandbox_id (str): the sandbox.
        """
        sandbox = (await self._call("GET", self._path(sandbox_id)))["sandbox"]
        return sandbox if isinstance(sandbox, dict) else {}

    async def delete(self, sandbox_id: str) -> None:
        """Delete the sandbox.

        Args:
            sandbox_id (str): the sandbox.
        """
        await self._call("DELETE", self._path(sandbox_id))

    async def sleep(self, sandbox_id: str) -> None:
        """Put the sandbox to sleep, its memory and disk kept; the next
        exec wakes it.

        Args:
            sandbox_id (str): the sandbox.
        """
        await self._call("POST", self._path(sandbox_id, "/sleep"))

    async def set_egress(
        self, sandbox_id: str, policy: Mapping[str, JsonValue]
    ) -> None:
        """Replace the sandbox's network policy, applied at once.

        Args:
            sandbox_id (str): the sandbox.
            policy (Mapping[str, JsonValue]): ``internet``, ``allow`` and
                ``deny``.
        """
        await self._call("PUT", self._path(sandbox_id, "/egress"), policy)

    async def upload(
        self, sandbox_id: str, path: str, content: AsyncIterator[bytes]
    ) -> None:
        """Write a file in the sandbox from a stream of bytes.

        Args:
            sandbox_id (str): the sandbox.
            path (str): the file's absolute path there.
            content (AsyncIterator[bytes]): its bytes.
        """
        response = await self._client.put(
            self._path(sandbox_id, "/files/raw"),
            params={"path": path},
            content=content,
            headers={"Content-Type": "application/octet-stream"},
            timeout=httpx.Timeout(REQUEST_TIMEOUT_SECONDS, write=None),
        )
        if response.is_error:
            raise await self._refusal(response)

    async def remove(self, sandbox_id: str, path: str) -> None:
        """Remove a file in the sandbox; one already gone is no error.

        Args:
            sandbox_id (str): the sandbox.
            path (str): the file's absolute path there.
        """
        try:
            await self._call(
                "DELETE",
                self._path(sandbox_id, "/files"),
                params={"path": path},
            )
        except Kosa8ApiError as exc:
            if exc.status != 404:
                raise

    async def exec(
        self,
        sandbox_id: str,
        argv: Sequence[str],
        env: Sequence[str],
    ) -> AsyncGenerator[ExecFrame, None]:
        """Run argv in the sandbox, its frames yielded as the command
        writes; the last carries its exit. Closing the iterator ends the
        stream but not the command, which kosa8 keeps running.

        Args:
            sandbox_id (str): the sandbox.
            argv (Sequence[str]): the program and its arguments.
            env (Sequence[str]): ``NAME=value`` entries.

        Raises:
            Kosa8ApiError: kosa8 refused the exec.
            Kosa8StreamCut: the stream ended before the exit.
        """
        body: dict[str, JsonValue] = {"cmd": list(argv), "stream": True}
        if env:
            body["env"] = list(env)
        async with self._client.stream(
            "POST",
            self._path(sandbox_id, "/exec"),
            json=body,
            timeout=httpx.Timeout(
                REQUEST_TIMEOUT_SECONDS, read=STREAM_QUIET_SECONDS
            ),
        ) as response:
            if response.is_error:
                raise await self._refusal(response)
            async for line in response.aiter_lines():
                if not line.strip():
                    continue
                frame = parse_frame(line.encode())
                if frame is None:
                    continue
                yield frame
                if frame.exit_code is not None:
                    return
        raise Kosa8StreamCut("the exec stream ended before the command exited")

    async def close(self) -> None:
        """Release the HTTP client."""
        await self._client.aclose()
