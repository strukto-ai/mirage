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
"""One adapter per access, each speaking only what its protocol has.

An access is a way into a workspace: in-app, HTTP, the CLI, MCP over
HTTP and ``mirage mcp``, RPC over HTTP and ``mirage rpc``, and SSH. Each
adapter turns a case's input into a call through its access and the
reply into the canonical answer the corpus pins, so every access is
compared with the in-app answer. ``OPS`` names the operations an access
has; the runner checks them against the corpus's ops table.
"""

import asyncio
import base64
import json
import os
import re
import shlex
import signal
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
import httpx2
import websockets
from deploy import ROOT, SEED, Deployment, mirage_cli
from mcp import Client, StdioServerParameters
from mcp.client.streamable_http import streamable_http_client

Answer = dict[str, Any]
CLI_GROUPS = (
    "workspace",
    "session",
    "job",
    "daemon",
    "config",
    "vfs",
    "tools",
)
WAITED = "the line waited for all of its input"
STREAM_WAIT = 10.0


def shell_answer(stdout: str, stderr: str, code: int) -> Answer:
    """A line's answer as the shell tool gives it.

    Args:
        stdout (str): the line's stdout.
        stderr (str): the line's stderr.
        code (int): its exit status.

    Returns:
        Answer: stdout, then stderr, and whether it failed.
    """
    text = f"{stdout}\n{stderr}" if stdout and stderr else stdout or stderr
    return {"text": text, "is_error": code != 0}


def io_answer(reply: dict[str, Any]) -> Answer:
    return shell_answer(
        reply["stdout"], reply["stderr"], int(reply["exit_code"])
    )


def tool_answer(reply: dict[str, Any]) -> Answer:
    return {"text": reply["text"], "is_error": bool(reply["is_error"])}


def stdin_bytes(spec: str | dict[str, Any]) -> bytes:
    """A case's stdin: a string, or ``{"repeat", "times"}`` for bulk.

    Args:
        spec (str | dict[str, Any]): the case's ``stdin``.

    Returns:
        bytes: the bytes to send.
    """
    if isinstance(spec, str):
        return spec.encode()
    return (spec["repeat"] * spec["times"]).encode()


class Recorder:
    """What the run touched: HTTP routes per server and CLI commands."""

    def __init__(self) -> None:
        self.requests: dict[str, set[tuple[str, str]]] = {}
        self.commands: dict[str, set[str]] = {}

    def hook(self, key: str) -> Callable[[Any], Awaitable[None]]:
        seen = self.requests.setdefault(key, set())

        async def record(request: Any) -> None:
            seen.add((request.method, request.url.path))

        return record

    def command(self, host: str, args: tuple[str, ...]) -> None:
        words = args[:2] if args and args[0] in CLI_GROUPS else args[:1]
        self.commands.setdefault(host, set()).add(" ".join(words))


async def run(
    argv: list[str],
    env: dict[str, str] | None = None,
    stdin: bytes | None = b"",
    timeout: float = 120,
    tty: bool = False,
) -> tuple[int, str, str]:
    """Run a command to its end.

    Args:
        argv (list[str]): the command.
        env (dict[str, str] | None): its environment.
        stdin (bytes | None): what to pipe in; ignored with ``tty``.
        timeout (float): seconds before it is killed.
        tty (bool): give it a terminal for stdin instead of a pipe.

    Returns:
        tuple[int, str, str]: exit status, stdout, stderr.
    """
    master = slave = -1
    if tty:
        master, slave = os.openpty()
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=ROOT,
        env=env,
        stdin=slave if tty else asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    if tty:
        os.close(slave)
    try:
        out, err = await asyncio.wait_for(
            process.communicate(None if tty else stdin), timeout
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        raise
    finally:
        if tty:
            os.close(master)
    return (
        process.returncode or 0,
        out.decode(errors="replace"),
        err.decode(errors="replace"),
    )


class RpcStream:
    """Line-delimited JSON-RPC over ``mirage rpc``'s stdio.

    Args:
        argv (list[str]): the ``mirage rpc`` command.
        env (dict[str, str]): its environment.
    """

    def __init__(self, argv: list[str], env: dict[str, str]) -> None:
        self.argv = argv
        self.env = env
        self.next_id = 0
        self.process: asyncio.subprocess.Process | None = None

    async def __aenter__(self) -> "RpcStream":
        self.process = await asyncio.create_subprocess_exec(
            *self.argv,
            cwd=ROOT,
            env=self.env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024,
        )
        return self

    async def __aexit__(self, *exc: object) -> None:
        assert self.process is not None and self.process.stdin is not None
        self.process.stdin.close()
        await asyncio.wait_for(self.process.wait(), 30)

    async def send(self, message: dict[str, Any]) -> None:
        assert self.process is not None and self.process.stdin is not None
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        await self.process.stdin.drain()

    async def receive(self, request_id: int) -> dict[str, Any]:
        assert self.process is not None and self.process.stdout is not None
        while True:
            line = await asyncio.wait_for(self.process.stdout.readline(), 60)
            if not line:
                assert self.process.stderr is not None
                err = await self.process.stderr.read()
                raise RuntimeError(f"mirage rpc closed its output: {err!r}")
            reply = json.loads(line)
            if reply.get("id") == request_id:
                return reply

    async def call(
        self, method: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        self.next_id += 1
        await self.send(rpc_request(self.next_id, method, params))
        return await self.receive(self.next_id)


def rpc_request(
    request_id: int, method: str, params: dict[str, Any]
) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": method,
        "params": params,
    }


def rpc_result(reply: dict[str, Any]) -> dict[str, Any]:
    if "error" in reply:
        raise RuntimeError(f"rpc error: {reply['error']}")
    return reply["result"]


def cli_args(tool: str, args: dict[str, Any]) -> list[str]:
    """A tool's JSON input as its CLI command's words.

    Args:
        tool (str): the tool.
        args (dict[str, Any]): its input.

    Returns:
        list[str]: the flags and operands.
    """
    if tool == "shell":
        return [args["command"]]
    if tool == "read":
        words = [args["path"]]
        for key in ("offset", "limit"):
            if key in args:
                words += [f"--{key}", str(args[key])]
        return words
    if tool == "write":
        return [args["path"], "--content", args["content"]]
    if tool == "edit":
        words = [args["path"], args["old_string"], args["new_string"]]
        return words + (["--replace-all"] if args.get("replace_all") else [])
    if tool == "ls":
        return [args["path"]]
    if tool == "glob":
        return [args["pattern"], args.get("path", "/")]
    flags = {
        "ignore_case": "-i",
        "fixed_strings": "-F",
        "files_with_matches": "-l",
        "count": "-c",
    }
    words = [flag for key, flag in flags.items() if args.get(key)]
    for key, flag in (("include", "--include"), ("context", "-C")):
        if key in args:
            words += [flag, str(args[key])]
    if "max_count" in args:
        words += ["-m", str(args["max_count"])]
    return words + [args["pattern"], args["path"]]


class Server:
    """A running deployment, as the accesses reach it.

    Args:
        deployment (Deployment): the running server.
        recorder (Recorder): where the run's routes and commands go.
    """

    def __init__(self, deployment: Deployment, recorder: Recorder) -> None:
        self.d = deployment
        self.recorder = recorder

    @property
    def host(self) -> str:
        return self.d.host

    @property
    def key(self) -> str:
        return f"{self.d.host}/{self.d.name}"

    def client(self, token: str | None = None) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.d.url,
            headers={"Authorization": f"Bearer {token or self.d.bearer()}"},
            timeout=120,
            event_hooks={"request": [self.recorder.hook(self.key)]},
        )

    def mcp_client(
        self, url: str, token: str | None = None
    ) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(
            headers={"Authorization": f"Bearer {token or self.d.bearer()}"},
            event_hooks={"request": [self.recorder.hook(self.key)]},
        )

    def cli(self, *args: str) -> list[str]:
        self.recorder.command(self.d.host, args)
        return mirage_cli(self.d.host, *args)

    def env(self, token: str | None = None) -> dict[str, str]:
        return self.d.cli_env(token)

    async def provision(
        self, suite: dict[str, Any], wid: str, config: dict[str, Any]
    ) -> None:
        """Create a suite's workspace, run its setup and make its session.

        Args:
            suite (dict[str, Any]): the suite.
            wid (str): the workspace id.
            config (dict[str, Any]): the workspace config.
        """
        async with self.client() as http:
            (
                await http.post(
                    "/v1/workspaces", json={"id": wid, "config": config}
                )
            ).raise_for_status()
            for line in suite.get("setup", []):
                reply = await http.post(
                    f"/v1/workspaces/{wid}/shell", json={"command": line}
                )
                reply.raise_for_status()
                assert reply.json()["exit_code"] == 0, (line, reply.json())
            session = suite.get("session")
            if session is not None:
                (
                    await http.post(
                        f"/v1/workspaces/{wid}/sessions",
                        json={
                            "session_id": session["id"],
                            "profile": session["profile"],
                        },
                    )
                ).raise_for_status()

    async def job_seen(
        self, wid: str, command: str, statuses: tuple[str, ...], timeout: float
    ) -> str:
        """Wait until a job of ``command`` shows one of ``statuses``.

        Args:
            wid (str): the workspace.
            command (str): the job's line.
            statuses (tuple[str, ...]): the statuses to wait for.
            timeout (float): seconds to wait.

        Returns:
            str: the status found last, or ``""`` when there was no job.
        """
        found = ""
        deadline = time.monotonic() + timeout
        async with self.client() as http:
            while time.monotonic() < deadline:
                rows = (
                    await http.get("/v1/jobs", params={"workspace_id": wid})
                ).json()
                found = next(
                    (r["status"] for r in rows if r["command"] == command), ""
                )
                if found in statuses:
                    break
                await asyncio.sleep(0.05)
        return found


class HttpSteps:
    """The admin steps over the HTTP routes."""

    def __init__(
        self, server: Server, config: dict[str, Any], snapshots: Path
    ) -> None:
        self.server = server
        self.config = config
        self.snapshots = snapshots
        self.http = server.client()

    async def close(self) -> None:
        await self.http.aclose()

    async def _ok(self, method: str, path: str, **kwargs: Any) -> Any:
        reply = await self.http.request(method, path, **kwargs)
        reply.raise_for_status()
        return reply.json() if reply.content else None

    async def create(self, wid: str) -> None:
        await self._ok(
            "POST", "/v1/workspaces", json={"id": wid, "config": self.config}
        )

    async def shell(
        self, wid: str, command: str, session: str | None
    ) -> Answer:
        params = {"session_id": session} if session is not None else {}
        return io_answer(
            await self._ok(
                "POST",
                f"/v1/workspaces/{wid}/shell",
                json={"command": command},
                params=params,
            )
        )

    async def ids(self) -> list[str]:
        return [w["id"] for w in await self._ok("GET", "/v1/workspaces")]

    async def mounts(self, wid: str) -> list[str]:
        detail = await self._ok("GET", f"/v1/workspaces/{wid}")
        return [m["prefix"] for m in detail["mounts"]]

    async def internals(self, wid: str) -> list[str]:
        detail = await self._ok(
            "GET", f"/v1/workspaces/{wid}", params={"verbose": "true"}
        )
        return sorted(detail["internals"] or {})

    async def clone(self, wid: str, to: str) -> None:
        await self._ok("POST", f"/v1/workspaces/{wid}/clone", json={"id": to})

    async def delete(self, wid: str) -> None:
        await self._ok("DELETE", f"/v1/workspaces/{wid}")

    async def session_create(
        self, wid: str, session: str, profile: str
    ) -> None:
        await self._ok(
            "POST",
            f"/v1/workspaces/{wid}/sessions",
            json={"session_id": session, "profile": profile},
        )

    async def session_ids(self, wid: str) -> list[str]:
        return [
            s["session_id"]
            for s in await self._ok("GET", f"/v1/workspaces/{wid}/sessions")
        ]

    async def session_delete(self, wid: str, session: str) -> None:
        await self._ok("DELETE", f"/v1/workspaces/{wid}/sessions/{session}")

    def _scope(self, wid: str, session: str | None) -> str:
        base = f"/v1/workspaces/{wid}"
        return base if session is None else f"{base}/sessions/{session}"

    async def cancel_lines(self, wid: str, session: str | None) -> int:
        reply = await self._ok("POST", f"{self._scope(wid, session)}/cancel")
        return reply["canceled"]

    async def kill_jobs(self, wid: str, session: str | None) -> int:
        reply = await self._ok("POST", f"{self._scope(wid, session)}/kill")
        return reply["killed"]

    async def document(
        self,
        wid: str,
        kind: str,
        session: str | None,
        profile: str | None,
        path: str | None,
    ) -> str:
        route = f"{self._scope(wid, session)}/{kind}-md"
        if path is None:
            params = {} if profile is None else {"profile": profile}
            reply = await self.http.get(route, params=params)
        else:
            reply = await self.http.put(route, json={"path": path})
        reply.raise_for_status()
        return reply.text

    async def session_update(
        self, wid: str, session: str, profile: str | None
    ) -> None:
        await self._ok(
            "PATCH",
            f"/v1/workspaces/{wid}/sessions/{session}",
            json={"profile": profile},
        )

    async def close_workspace(self, wid: str) -> None:
        await self._ok("POST", f"/v1/workspaces/{wid}/close")

    async def snapshot(self, wid: str, name: str) -> None:
        reply = await self.http.get(f"/v1/workspaces/{wid}/snapshot")
        reply.raise_for_status()
        (self.snapshots / name).write_bytes(reply.content)

    async def load(self, name: str, to: str) -> None:
        await self._ok(
            "POST",
            "/v1/workspaces/load",
            files={
                "request": (
                    "request.json",
                    json.dumps({"id": to}),
                    "application/json",
                ),
                "snapshot": (
                    name,
                    (self.snapshots / name).read_bytes(),
                    "application/x-tar",
                ),
            },
        )

    async def store_snapshot(self, wid: str, key: str) -> None:
        await self._ok(
            "POST", f"/v1/workspaces/{wid}/snapshot", json={"key": key}
        )

    async def store_load(self, key: str, to: str) -> None:
        await self._ok(
            "POST", "/v1/workspaces/load", json={"key": key, "id": to}
        )

    async def asks(self, wid: str) -> list[tuple[str, str]]:
        return [
            (a["id"], a["reason"])
            for a in await self._ok("GET", f"/v1/workspaces/{wid}/asks")
        ]

    async def explain(
        self, wid: str, session: str, command: str
    ) -> tuple[str, int]:
        said = await self._ok(
            "POST",
            f"/v1/workspaces/{wid}/shell",
            json={"command": command},
            params={"session_id": session, "explain": "true"},
        )
        return said["outcome"], said["exit_code"]

    async def allow(self, wid: str, ask: str) -> None:
        await self._ok(
            "POST",
            f"/v1/workspaces/{wid}/asks/{ask}",
            json={"answer": "allow"},
        )

    async def deny(self, wid: str, ask: str) -> None:
        await self._ok(
            "POST", f"/v1/workspaces/{wid}/asks/{ask}", json={"answer": "deny"}
        )

    async def background(self, wid: str, command: str) -> str:
        reply = await self._ok(
            "POST",
            f"/v1/workspaces/{wid}/shell",
            params={"background": "true"},
            json={"command": command},
        )
        return reply["job_id"]

    async def wait(self, job: str) -> tuple[str, str]:
        reply = await self._ok(
            "POST", f"/v1/jobs/{job}/wait", json={"timeout_s": 60}
        )
        return reply["status"], (reply.get("result") or {}).get("stdout", "")

    async def status(self, job: str) -> str:
        return (await self._ok("GET", f"/v1/jobs/{job}"))["status"]

    async def job_commands(self, wid: str) -> list[str]:
        return [
            j["command"]
            for j in await self._ok(
                "GET", "/v1/jobs", params={"workspace_id": wid}
            )
        ]

    async def cancel(self, job: str) -> None:
        await self._ok("DELETE", f"/v1/jobs/{job}")


class CliSteps:
    """The admin steps through the ``mirage`` CLI."""

    def __init__(
        self,
        server: Server,
        config: dict[str, Any],
        snapshots: Path,
        scratch: Path,
    ) -> None:
        self.server = server
        self.snapshots = snapshots
        self.config_file = scratch / "workspace.json"
        self.config_file.write_text(json.dumps(config))

    async def close(self) -> None:
        return None

    async def _json(self, *args: str, tty: bool = False) -> Any:
        code, out, err = await run(
            self.server.cli(*args), self.server.env(), tty=tty
        )
        if code != 0:
            raise RuntimeError(f"mirage {' '.join(args)} exited {code}: {err}")
        return json.loads(out) if out.strip() else None

    async def create(self, wid: str) -> None:
        await self._json(
            "workspace", "create", str(self.config_file), "--id", wid
        )

    async def shell(
        self, wid: str, command: str, session: str | None
    ) -> Answer:
        args = ["shell", "-w", wid, "-c", command]
        if session is not None:
            args += ["-s", session]
        code, out, err = await run(
            self.server.cli(*args), self.server.env(), tty=True
        )
        if not out.strip():
            raise RuntimeError(f"mirage shell exited {code}: {err}")
        return io_answer(json.loads(out))

    async def ids(self) -> list[str]:
        return [w["id"] for w in await self._json("workspace", "list")]

    async def mounts(self, wid: str) -> list[str]:
        return [
            m["prefix"]
            for m in (await self._json("workspace", "get", wid))["mounts"]
        ]

    async def internals(self, wid: str) -> list[str]:
        return sorted(
            (await self._json("workspace", "get", wid, "--verbose"))[
                "internals"
            ]
            or {}
        )

    async def clone(self, wid: str, to: str) -> None:
        await self._json("workspace", "clone", wid, "--id", to)

    async def delete(self, wid: str) -> None:
        await self._json("workspace", "delete", wid)

    async def session_create(
        self, wid: str, session: str, profile: str
    ) -> None:
        await self._json(
            "session", "create", wid, "--id", session, "-p", profile
        )

    async def session_ids(self, wid: str) -> list[str]:
        return [
            s["session_id"] for s in await self._json("session", "list", wid)
        ]

    async def session_delete(self, wid: str, session: str) -> None:
        await self._json("session", "delete", wid, session)

    async def cancel_lines(self, wid: str, session: str | None) -> int:
        args = (
            ("workspace", wid)
            if session is None
            else ("session", wid, session)
        )
        reply = await self._json(args[0], "cancel", *args[1:])
        return reply["canceled"]

    async def kill_jobs(self, wid: str, session: str | None) -> int:
        args = (
            ("workspace", wid)
            if session is None
            else ("session", wid, session)
        )
        reply = await self._json(args[0], "kill", *args[1:])
        return reply["killed"]

    async def document(
        self,
        wid: str,
        kind: str,
        session: str | None,
        profile: str | None,
        path: str | None,
    ) -> str:
        args = ["workspace", f"{kind}-md", wid]
        for flag, value in (
            ("--session", session),
            ("--profile", profile),
            ("--path", path),
        ):
            if value is not None:
                args += [flag, value]
        code, out, err = await run(self.server.cli(*args), self.server.env())
        if code != 0:
            raise RuntimeError(f"mirage {' '.join(args)} exited {code}: {err}")
        return out

    async def session_update(
        self, wid: str, session: str, profile: str | None
    ) -> None:
        chosen = (
            ["-p", profile] if profile is not None else ["--default-profile"]
        )
        await self._json("session", "update", wid, session, *chosen)

    async def close_workspace(self, wid: str) -> None:
        await self._json("workspace", "close", wid)

    async def snapshot(self, wid: str, name: str) -> None:
        await self._json(
            "workspace", "snapshot", wid, str(self.snapshots / name)
        )

    async def load(self, name: str, to: str) -> None:
        await self._json(
            "workspace", "load", str(self.snapshots / name), "--id", to
        )

    async def store_snapshot(self, wid: str, key: str) -> None:
        await self._json("workspace", "snapshot", wid, "--key", key)

    async def store_load(self, key: str, to: str) -> None:
        await self._json("workspace", "load", "--key", key, "--id", to)

    async def asks(self, wid: str) -> list[tuple[str, str]]:
        return [
            (a["id"], a["reason"])
            for a in await self._json("workspace", "list-asks", wid)
        ]

    async def explain(
        self, wid: str, session: str, command: str
    ) -> tuple[str, int]:
        said = await self._json(
            "shell", "-w", wid, "-s", session, "-c", command, "--explain"
        )
        return said["outcome"], said["exit_code"]

    async def allow(self, wid: str, ask: str) -> None:
        await self._json("workspace", "allow", wid, ask)

    async def deny(self, wid: str, ask: str) -> None:
        await self._json("workspace", "deny", wid, ask)

    async def background(self, wid: str, command: str) -> str:
        return (
            await self._json(
                "shell", "-w", wid, "--bg", "-c", command, tty=True
            )
        )["job_id"]

    async def wait(self, job: str) -> tuple[str, str]:
        code, out, err = await run(
            self.server.cli("job", "wait", job, "--timeout", "60"),
            self.server.env(),
        )
        reply = json.loads(out)
        return reply["status"], (reply.get("result") or {}).get("stdout", "")

    async def status(self, job: str) -> str:
        code, out, err = await run(
            self.server.cli("job", "get", job), self.server.env()
        )
        return json.loads(out)["status"]

    async def job_commands(self, wid: str) -> list[str]:
        return [
            j["command"] for j in await self._json("job", "list", "-w", wid)
        ]

    async def cancel(self, job: str) -> None:
        await self._json("job", "cancel", job)


def _headings(markdown: str) -> str:
    """The mount paths a VFS.md names, one per ``## `/path` `` heading.

    Args:
        markdown (str): the rendered document.
    """
    return " ".join(
        line[4:-1]
        for line in markdown.splitlines()
        if line.startswith("## `") and line.endswith("`")
    )


def _prefix(path: str) -> str:
    return path.rstrip("/") or "/"


class InAppSteps:
    """The admin steps through the in-app Python API."""

    def __init__(
        self, config: dict[str, Any], scratch: Path, store: dict[str, Any]
    ) -> None:
        self.config = config
        self.scratch = scratch
        self.store = store
        self.workspaces: dict[str, Any] = {}

    async def close(self) -> None:
        for ws in self.workspaces.values():
            await ws.close()

    async def create(self, wid: str) -> None:
        from mirage.server.workspace_config import build_workspace_from_config

        path = self.scratch / f"{wid}.json"
        path.write_text(json.dumps({**self.config, "workspace_id": wid}))
        self.workspaces[wid] = await build_workspace_from_config(path)

    async def shell(
        self, wid: str, command: str, session: str | None
    ) -> Answer:
        ws = self.workspaces[wid]
        io = (
            await (await ws.session(session)).shell(command)
            if session
            else await ws.shell(command)
        )
        return shell_answer(
            await io.stdout_str(), await io.stderr_str(), io.exit_code
        )

    async def ids(self) -> list[str]:
        return list(self.workspaces)

    async def mounts(self, wid: str) -> list[str]:
        return [m.prefix for m in self.workspaces[wid].mounts()]

    async def clone(self, wid: str, to: str) -> None:
        self.workspaces[to] = await self.workspaces[wid].copy()

    async def delete(self, wid: str) -> None:
        await self.workspaces.pop(wid).close()

    async def session_create(
        self, wid: str, session: str, profile: str
    ) -> None:
        self.workspaces[wid].create_session(session, profile=profile)

    async def session_ids(self, wid: str) -> list[str]:
        return [s.session_id for s in self.workspaces[wid].list_sessions()]

    async def session_delete(self, wid: str, session: str) -> None:
        await self.workspaces[wid].close_session(session)

    async def cancel_lines(self, wid: str, session: str | None) -> int:
        return await self.workspaces[wid].cancel(session)

    async def kill_jobs(self, wid: str, session: str | None) -> int:
        return await self.workspaces[wid].kill(session)

    async def document(
        self,
        wid: str,
        kind: str,
        session: str | None,
        profile: str | None,
        path: str | None,
    ) -> str:
        ws = self.workspaces[wid]
        method = ws.vfs_md if kind == "vfs" else ws.skill_md
        return await method(path, session_id=session, profile=profile)

    async def session_update(
        self, wid: str, session: str, profile: str | None
    ) -> None:
        await self.workspaces[wid].set_session_profile(session, profile)

    async def close_workspace(self, wid: str) -> None:
        await self.workspaces.pop(wid).close()

    async def snapshot(self, wid: str, name: str) -> None:
        await self.workspaces[wid].snapshot(str(self.scratch / name))

    async def load(self, name: str, to: str) -> None:
        from mirage import Workspace

        self.workspaces[to] = await Workspace.load(str(self.scratch / name))

    async def store_snapshot(self, wid: str, key: str) -> None:
        from mirage.vfs.s3.config import S3Config

        await self.workspaces[wid].snapshot(key, s3=S3Config(**self.store))

    async def store_load(self, key: str, to: str) -> None:
        from mirage import Workspace
        from mirage.vfs.s3.config import S3Config

        self.workspaces[to] = await Workspace.load(
            key, s3=S3Config(**self.store)
        )

    async def asks(self, wid: str) -> list[tuple[str, str]]:
        return [
            (d.id, d.reason) for d in self.workspaces[wid].decisions.pending()
        ]

    async def explain(
        self, wid: str, session: str, command: str
    ) -> tuple[str, int]:
        explain = (await self.workspaces[wid].session(session)).explain
        said = await explain.shell(command)
        return said.outcome.value, said.exit_code

    async def allow(self, wid: str, ask: str) -> None:
        from mirage.policy.types import Outcome

        await self.workspaces[wid].decisions.answer(ask, Outcome.ALLOW)

    async def deny(self, wid: str, ask: str) -> None:
        from mirage.policy.types import Outcome

        await self.workspaces[wid].decisions.answer(ask, Outcome.DENY)


async def run_steps(
    steps: Any, suite: dict[str, Any], prefix: str, config: dict[str, Any]
) -> list[Answer]:
    """Run an admin suite's steps through one access.

    Workspace ids carry ``prefix`` so accesses sharing a server never
    meet; answers name them without it.

    Args:
        steps (Any): the access's steps.
        suite (dict[str, Any]): the suite.
        prefix (str): the prefix for this access's workspace ids.
        config (dict[str, Any]): the workspace config.

    Returns:
        list[Answer]: one answer per case.
    """
    declared = {_prefix(p) for p in config["mounts"]}
    named: set[str] = set()
    jobs: list[str] = []
    answers: list[Answer] = []
    try:
        for case in suite["cases"]:
            step = case["input"]
            kind = step["step"]
            wid = prefix + step["id"] if "id" in step else ""
            if kind == "create":
                await steps.create(wid)
                answer: Answer = {"text": step["id"]}
            elif kind == "shell":
                answer = await steps.shell(
                    wid, step["command"], step.get("session")
                )
            elif kind == "list":
                own = sorted(
                    i[len(prefix) :]
                    for i in await steps.ids()
                    if i.startswith(prefix)
                )
                answer = {"text": " ".join(own)}
            elif kind == "mounts":
                found = {_prefix(p) for p in await steps.mounts(wid)}
                answer = {"text": " ".join(sorted(found & declared))}
            elif kind == "internals":
                found = await steps.internals(wid)
                answer = {
                    "text": " ".join(
                        k for k in found if k.startswith("cache_")
                    )
                }
            elif kind == "clone":
                await steps.clone(wid, prefix + step["to"])
                answer = {"text": step["to"]}
            elif kind == "delete":
                await steps.delete(wid)
                answer = {"text": "deleted"}
            elif kind == "session_create":
                await steps.session_create(
                    wid, step["session"], step["profile"]
                )
                named.add(step["session"])
                answer = {"text": step["session"]}
            elif kind == "session_list":
                found = await steps.session_ids(wid)
                answer = {
                    "text": " ".join(sorted(i for i in found if i in named))
                }
            elif kind == "session_delete":
                await steps.session_delete(wid, step["session"])
                answer = {"text": "deleted"}
            elif kind == "cancel_lines":
                canceled = await steps.cancel_lines(wid, step.get("session"))
                answer = {"text": str(canceled)}
            elif kind == "kill_jobs":
                killed = await steps.kill_jobs(wid, step.get("session"))
                answer = {"text": str(killed)}
            elif kind == "document":
                markdown = await steps.document(
                    wid,
                    step["kind"],
                    step.get("session"),
                    step.get("profile"),
                    None,
                )
                answer = {"text": _headings(markdown)}
            elif kind == "expose":
                await steps.document(
                    wid, step["kind"], step.get("session"), None, step["path"]
                )
                answer = {"text": "exposed"}
            elif kind == "session_update":
                await steps.session_update(
                    wid, step["session"], step.get("profile")
                )
                answer = {"text": step["session"]}
            elif kind == "close_workspace":
                await steps.close_workspace(wid)
                answer = {"text": "closed"}
            elif kind == "snapshot":
                await steps.snapshot(wid, prefix + step["name"])
                answer = {"text": "saved"}
            elif kind == "load":
                await steps.load(prefix + step["name"], prefix + step["to"])
                answer = {"text": step["to"]}
            elif kind == "store_snapshot":
                await steps.store_snapshot(wid, prefix + step["key"])
                answer = {"text": "saved"}
            elif kind == "store_load":
                await steps.store_load(
                    prefix + step["key"], prefix + step["to"]
                )
                answer = {"text": step["to"]}
            elif kind == "asks":
                answer = {
                    "text": "\n".join(
                        reason for _, reason in await steps.asks(wid)
                    )
                }
            elif kind == "explain":
                outcome, code = await steps.explain(
                    wid, step["session"], step["command"]
                )
                answer = {"text": f"{outcome} {code}"}
            elif kind in ("allow", "deny"):
                pending = await steps.asks(wid)
                await getattr(steps, kind)(wid, pending[0][0])
                answer = {"text": {"allow": "allowed", "deny": "denied"}[kind]}
            elif kind == "background":
                jobs.append(await steps.background(wid, step["command"]))
                answer = {"text": "submitted"}
            elif kind == "wait":
                status, stdout = await steps.wait(jobs[-1])
                answer = {"text": status, "stdout": stdout}
            elif kind == "get":
                answer = {"text": await steps.status(jobs[-1])}
            elif kind == "jobs":
                answer = {
                    "text": "\n".join(sorted(await steps.job_commands(wid)))
                }
            elif kind == "cancel":
                await steps.cancel(jobs[-1])
                answer = {"text": "canceling"}
            else:
                raise ValueError(f"unknown step {kind}")
            answers.append(answer)
    finally:
        await steps.close()
    return answers


STEP_OPS = frozenset({"workspace", "session_admin", "snapshot", "ask", "job"})


def _entries(path: str, names: list[str]) -> list[str]:
    base = path.rstrip("/")
    return sorted(n if n.startswith("/") else f"{base}/{n}" for n in names)


def _type(value: Any) -> str:
    return str(getattr(value, "value", value))


LISTED = {"list_files": "files", "listxattr": "names", "glob": "paths"}


def bytes_answer(step: dict[str, Any], wire: dict[str, Any]) -> Answer:
    """One VFS call's answer as every access must give it: the call's
    JSON, a stat narrowed to its type and size and a listing sorted, or
    the errno a failure names.

    Args:
        step (dict[str, Any]): the case's input, naming the call.
        wire (dict[str, Any]): the call's JSON, or ``{"errno": ...}``.
    """
    if "errno" in wire:
        return {"error": wire["errno"]}
    call = step["call"]
    if call == "stat":
        return {"type": wire["type"], "size": wire["size"]}
    if call == "readdir":
        return {"entries": _entries(step["path"], wire["entries"])}
    if call in LISTED:
        return {LISTED[call]: sorted(wire[LISTED[call]])}
    return wire


def _commands(node: dict[str, Any]) -> list[list[Any]]:
    mine = (
        [[node["command"], node["outcome"], node["exit_code"]]]
        if "command" in node
        else []
    )
    return mine + [c for child in node["children"] for c in _commands(child)]


def explain_answer(wire: dict[str, Any]) -> Answer:
    """An explanation as every access must give it: the verdict, then a
    VFS call's error, or a line's exit code, stderr and each command's
    verdict in source order.

    Args:
        wire (dict[str, Any]): the explanation's JSON.
    """
    refusal = wire["refusal"]
    said = {
        "outcome": wire["outcome"],
        "reason": wire["reason"],
        "source": wire["source"],
        "refusal": refusal["kind"] if refusal else None,
    }
    if "call" in wire:
        return {**said, "call": wire["call"], "error": wire["error"]}
    return {
        **said,
        "exit_code": wire["exit_code"],
        "stderr": wire["stderr"],
        "commands": _commands(wire["node"]),
    }


def call_params(step: dict[str, Any]) -> dict[str, Any]:
    """A bytes or explain case's arguments, without the case's own keys.

    Args:
        step (dict[str, Any]): the case's input.
    """
    return {
        k: v for k, v in step.items() if k not in ("call", "via", "explain")
    }


def vfs_words(step: dict[str, Any]) -> tuple[list[str], bytes]:
    """A VFS call as its ``mirage vfs`` command's words, with the bytes
    it reads on stdin.

    Args:
        step (dict[str, Any]): the case's input.

    Returns:
        tuple[list[str], bytes]: the words after ``mirage``, and stdin.
    """
    from mirage.server.vfs_calls import BYTES, FLAG, VFS_CALL_BY_NAME

    if step["call"] == "glob":
        return ["glob", step["pattern"]], b""
    call = VFS_CALL_BY_NAME[step["call"]]
    words = ["vfs", call.name.replace("_", "-")]
    stdin = b""
    for name, schema in call.params.items():
        if name not in step:
            continue
        if schema is BYTES:
            stdin = base64.b64decode(step[name])
        elif name in call.required:
            words.append(str(step[name]))
        elif schema is FLAG:
            words += [f"--{name}"] if step[name] else []
        else:
            words += [f"--{name}", str(step[name])]
    return words, stdin


def wire_failure(status: int, body: Any) -> dict[str, Any]:
    """A refused or failed call's answer off an HTTP error body.

    Args:
        status (int): the response status.
        body (Any): its JSON body.
    """
    errno = body.get("errno") if isinstance(body, dict) else None
    return {"errno": errno or f"HTTP {status}"}


class InAppPython:
    """In-app on the Python host: ``Workspace`` and ``Session`` in this process."""

    name = "inapp"
    OPS = frozenset(
        {
            "shell",
            "stdin",
            "tool",
            "bytes",
            "explain",
            "cancel",
            "session",
            "workspace",
            "session_admin",
            "snapshot",
            "ask",
        }
    )

    def __init__(self, scratch: Path, store: dict[str, Any]) -> None:
        self.scratch = scratch
        self.store = store

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        from mirage.server.workspace_config import build_workspace_from_config

        scratch = self.scratch / prefix
        scratch.mkdir(parents=True, exist_ok=True)
        if suite["op"] in STEP_OPS:
            return await run_steps(
                InAppSteps(config, scratch, self.store), suite, prefix, config
            )
        path = scratch / "workspace.json"
        path.write_text(json.dumps(config))
        ws = await build_workspace_from_config(path)
        try:
            for line in suite.get("setup", []):
                io = await ws.shell(line)
                assert io.exit_code == 0, (line, await io.stderr_str())
            spec = suite.get("session")
            session = (
                await ws.session(spec["id"], profile=spec["profile"])
                if spec
                else await ws.session(ws.default_session_id)
            )
            tools = session.tools
            answers = []
            for case in suite["cases"]:
                answers.append(
                    await self.case(suite["op"], session, tools, case["input"])
                )
            return answers
        finally:
            await ws.close()

    async def case(
        self, op: str, session: Any, tools: Any, step: dict[str, Any]
    ) -> Answer:
        if op in ("shell", "session"):
            io = await session.shell(step["command"])
            return shell_answer(
                await io.stdout_str(), await io.stderr_str(), io.exit_code
            )
        if op == "stdin":
            return await self.stdin(session, step)
        if op == "tool":
            result = await tools.call(step["tool"], step["arguments"])
            return {"text": result.text, "is_error": result.is_error}
        if op == "bytes":
            return await self.bytes(session, step)
        if op == "explain":
            return await self.explain(session, step)
        if op == "cancel":
            cancel = asyncio.Event()
            asyncio.get_running_loop().call_later(0.5, cancel.set)
            try:
                await session.shell(step["command"], cancel=cancel)
            except asyncio.CancelledError:
                return {"text": "canceled"}
            except Exception as exc:
                return {
                    "text": "canceled"
                    if type(exc).__name__ == "MirageAbortError"
                    else repr(exc)
                }
            return {"text": "finished"}
        raise ValueError(op)

    async def stdin(self, session: Any, step: dict[str, Any]) -> Answer:
        if "stream" not in step:
            io = await session.shell(
                step["command"], stdin=stdin_bytes(step["stdin"])
            )
            return shell_answer(
                await io.stdout_str(), await io.stderr_str(), io.exit_code
            )
        done = asyncio.Event()
        waited = False

        async def produce() -> AsyncIterator[bytes]:
            nonlocal waited
            first, *rest = step["stream"]
            yield first.encode()
            try:
                await asyncio.wait_for(done.wait(), STREAM_WAIT)
            except TimeoutError:
                waited = True
            for chunk in rest:
                yield chunk.encode()

        line = asyncio.ensure_future(
            session.shell(step["command"], stdin=produce())
        )
        line.add_done_callback(lambda _: done.set())
        io = await line
        if waited:
            return {"text": WAITED, "is_error": True}
        return shell_answer(
            await io.stdout_str(), await io.stderr_str(), io.exit_code
        )

    async def bytes(self, session: Any, step: dict[str, Any]) -> Answer:
        from mirage.errors.classify import classify
        from mirage.server.vfs_calls import VFS_CALL_BY_NAME, answered, checked

        params = call_params(step)
        try:
            if step["call"] == "glob":
                wire = {"paths": list(await session.glob(params["pattern"]))}
            else:
                call = VFS_CALL_BY_NAME[step["call"]]
                wire = await answered(
                    session, call, checked(call, params), False
                )
        except OSError as exc:
            condition = classify(exc)
            wire = {"errno": condition.name if condition else repr(exc)}
        return bytes_answer(step, wire)

    async def explain(self, session: Any, step: dict[str, Any]) -> Answer:
        from mirage.server.io_serde import explanation_to_dict
        from mirage.server.vfs_calls import VFS_CALL_BY_NAME, answered, checked

        if step["call"] == "shell":
            said = await session.explain.shell(step["command"])
            return explain_answer(explanation_to_dict(said))
        call = VFS_CALL_BY_NAME[step["call"]]
        wire = await answered(
            session, call, checked(call, call_params(step)), True
        )
        return explain_answer(wire)


class InAppTypeScript:
    """In-app on the TypeScript host, through ``inapp.ts``."""

    name = "inapp"
    OPS = InAppPython.OPS

    def __init__(self, scratch: Path, store: dict[str, Any]) -> None:
        self.scratch = scratch
        self.store = store

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        scratch = self.scratch / prefix
        scratch.mkdir(parents=True, exist_ok=True)
        request = json.dumps(
            {
                "suite": suite,
                "prefix": prefix,
                "config": config,
                "scratch": str(scratch),
                "store": self.store,
            }
        )
        process = await asyncio.create_subprocess_exec(
            "node",
            "--import",
            "tsx",
            "access/inapp.ts",
            cwd=ROOT / "integ",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(
            process.communicate(request.encode()), 300
        )
        if process.returncode != 0:
            raise RuntimeError(f"inapp.ts failed: {err.decode()}")
        answers = json.loads(out)
        if suite["op"] == "bytes":
            return [
                bytes_answer(c["input"], a)
                for c, a in zip(suite["cases"], answers, strict=True)
            ]
        if suite["op"] == "explain":
            return [explain_answer(a) for a in answers]
        return answers


class Http:
    """The HTTP routes."""

    name = "http"
    OPS = frozenset(
        {
            "shell",
            "stdin",
            "tool",
            "bytes",
            "explain",
            "cancel",
            "session",
            "workspace",
            "session_admin",
            "snapshot",
            "ask",
            "job",
        }
    )

    def __init__(self, server: Server, scratch: Path) -> None:
        self.server = server
        self.scratch = scratch

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        if suite["op"] in STEP_OPS:
            scratch = self.scratch / prefix
            scratch.mkdir(parents=True, exist_ok=True)
            return await run_steps(
                HttpSteps(self.server, config, scratch),
                suite,
                prefix,
                config,
            )
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        async with self.server.client() as http:
            return [
                await self.case(http, suite["op"], wid, session, c["input"])
                for c in suite["cases"]
            ]

    async def case(
        self,
        http: httpx.AsyncClient,
        op: str,
        wid: str,
        session: str | None,
        step: dict[str, Any],
    ) -> Answer:
        base = f"/v1/workspaces/{wid}"
        params = {"session_id": session} if session else {}
        if op in ("shell", "session"):
            reply = await http.post(
                f"{base}/shell",
                json={"command": step["command"]},
                params=params,
            )
            reply.raise_for_status()
            return io_answer(reply.json())
        if op == "tool":
            reply = await http.post(
                f"{base}/tools/{step['tool']}",
                json=step["arguments"],
                params=params,
            )
            reply.raise_for_status()
            return tool_answer(reply.json())
        if op == "bytes":
            route = "glob" if step["call"] == "glob" else f"vfs/{step['call']}"
            reply = await http.post(
                f"{base}/{route}", json=call_params(step), params=params
            )
            if reply.status_code >= 400:
                return bytes_answer(
                    step, wire_failure(reply.status_code, reply.json())
                )
            return bytes_answer(step, reply.json())
        if op == "explain":
            route = (
                "shell" if step["call"] == "shell" else f"vfs/{step['call']}"
            )
            reply = await http.post(
                f"{base}/{route}",
                json=call_params(step),
                params={**params, "explain": "true"},
            )
            reply.raise_for_status()
            return explain_answer(reply.json())
        if op == "stdin" and "stream" not in step:
            request = json.dumps({"command": step["command"]})
            reply = await http.post(
                f"{base}/shell",
                params=params,
                files={
                    "request": ("request.json", request, "application/json"),
                    "stdin": (
                        "stdin.bin",
                        stdin_bytes(step["stdin"]),
                        "application/octet-stream",
                    ),
                },
            )
            reply.raise_for_status()
            return io_answer(reply.json())
        if op == "stdin":
            return await self.stream(http, wid, step)
        if op == "cancel":
            try:
                await http.post(
                    f"{base}/shell",
                    json={"command": step["command"]},
                    timeout=1,
                )
            except httpx.TimeoutException:
                pass
            return {
                "text": await self.server.job_seen(
                    wid, step["command"], ("canceled",), 15
                )
            }
        raise ValueError(op)

    async def stream(
        self, http: httpx.AsyncClient, wid: str, step: dict[str, Any]
    ) -> Answer:
        boundary = "access-integ"
        first, *rest = step["stream"]
        waited = False

        async def body() -> AsyncIterator[bytes]:
            nonlocal waited
            disposition = "Content-Disposition: form-data"
            yield (
                f'--{boundary}\r\n{disposition}; name="request"\r\n\r\n'
                f"{json.dumps({'command': step['command']})}\r\n"
                f"--{boundary}\r\n"
                f'{disposition}; name="stdin"; filename="stdin.bin"\r\n\r\n'
                f"{first}"
            ).encode()
            seen = await self.server.job_seen(
                wid, step["command"], ("running", "done"), STREAM_WAIT
            )
            waited = seen not in ("running", "done")
            yield ("".join(rest) + f"\r\n--{boundary}--\r\n").encode()

        reply = await http.post(
            f"/v1/workspaces/{wid}/shell",
            content=body(),
            headers={
                "content-type": f"multipart/form-data; boundary={boundary}"
            },
        )
        reply.raise_for_status()
        if waited:
            return {"text": WAITED, "is_error": True}
        return io_answer(reply.json())


class Cli:
    """The ``mirage`` CLI."""

    name = "cli"
    OPS = frozenset(
        {
            "shell",
            "stdin",
            "tool",
            "bytes",
            "explain",
            "cancel",
            "session",
            "workspace",
            "session_admin",
            "snapshot",
            "ask",
            "job",
        }
    )

    def __init__(self, server: Server, scratch: Path) -> None:
        self.server = server
        self.scratch = scratch

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        if suite["op"] in STEP_OPS:
            scratch = self.scratch / prefix
            scratch.mkdir(parents=True, exist_ok=True)
            return await run_steps(
                CliSteps(self.server, config, scratch, scratch),
                suite,
                prefix,
                config,
            )
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        return [
            await self.case(suite["op"], wid, session, c["input"])
            for c in suite["cases"]
        ]

    def _session(self, session: str | None) -> list[str]:
        return ["-s", session] if session else []

    async def case(
        self, op: str, wid: str, session: str | None, step: dict[str, Any]
    ) -> Answer:
        env = self.server.env()
        if op in ("shell", "session"):
            argv = self.server.cli(
                "shell",
                "-w",
                wid,
                *self._session(session),
                "-c",
                step["command"],
            )
            code, out, err = await run(argv, env, tty=True)
            return (
                io_answer(json.loads(out))
                if out.strip()
                else {"text": err, "is_error": True}
            )
        if op == "tool":
            argv = self.server.cli(
                "tools",
                step["tool"],
                "-w",
                wid,
                *self._session(session),
                *cli_args(step["tool"], step["arguments"]),
            )
            code, out, err = await run(argv, env)
            return tool_answer(json.loads(out))
        if op == "bytes":
            words, stdin = vfs_words(step)
            argv = self.server.cli(*words, "-w", wid, *self._session(session))
            code, out, err = await run(argv, env, stdin=stdin)
            if code != 0:
                named = re.search(r"\(([A-Z][A-Z_]+)\)", err)
                return bytes_answer(
                    step, {"errno": named.group(1) if named else err.strip()}
                )
            return bytes_answer(step, json.loads(out))
        if op == "explain":
            words = (
                ["shell", "-c", step["command"]]
                if step["call"] == "shell"
                else vfs_words(step)[0]
            )
            argv = self.server.cli(
                *words, "-w", wid, *self._session(session), "--explain"
            )
            code, out, err = await run(argv, env)
            if not out.strip():
                raise RuntimeError(
                    f"mirage {' '.join(words)} --explain: {err}"
                )
            return explain_answer(json.loads(out))
        if op == "stdin" and "stream" not in step:
            argv = self.server.cli("shell", "-w", wid, "-c", step["command"])
            code, out, err = await run(
                argv, env, stdin=stdin_bytes(step["stdin"])
            )
            return (
                io_answer(json.loads(out))
                if out.strip()
                else {"text": err, "is_error": True}
            )
        if op == "stdin":
            return await self.stream(wid, step, env)
        if op == "cancel":
            return {"text": await self.cancel(wid, step["command"], env)}
        raise ValueError(op)

    async def stream(
        self, wid: str, step: dict[str, Any], env: dict[str, str]
    ) -> Answer:
        first, *rest = step["stream"]
        process = await asyncio.create_subprocess_exec(
            *self.server.cli("shell", "-w", wid, "-c", step["command"]),
            cwd=ROOT,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        assert process.stdin is not None
        process.stdin.write(first.encode())
        await process.stdin.drain()
        seen = await self.server.job_seen(
            wid, step["command"], ("running", "done"), STREAM_WAIT
        )
        process.stdin.write("".join(rest).encode())
        process.stdin.close()
        out, err = await asyncio.wait_for(process.communicate(), 60)
        if seen not in ("running", "done"):
            return {"text": WAITED, "is_error": True}
        return io_answer(json.loads(out))

    async def cancel(self, wid: str, command: str, env: dict[str, str]) -> str:
        results = []
        for tty, line in (
            (True, f"{command} # tty"),
            (False, f"{command} # piped"),
        ):
            master = slave = -1
            if tty:
                master, slave = os.openpty()
            process = await asyncio.create_subprocess_exec(
                *self.server.cli("shell", "-w", wid, "-c", line),
                cwd=ROOT,
                env=env,
                stdin=slave if tty else asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if tty:
                os.close(slave)
            elif process.stdin is not None:
                process.stdin.write(b"\n")
                await process.stdin.drain()
            await self.server.job_seen(wid, line, ("running",), 15)
            process.send_signal(signal.SIGINT)
            code = await asyncio.wait_for(process.wait(), 15)
            if tty:
                os.close(master)
            status = await self.server.job_seen(wid, line, ("canceled",), 15)
            results.append(
                "canceled"
                if code == 130 and status == "canceled"
                else f"exit {code}, job {status}"
            )
        return results[0] if results[0] == results[1] else " / ".join(results)


ALL_CALLS = frozenset({"bytes", "explain"})


class Mcp:
    """MCP over the HTTP endpoint. The ``bytes`` and ``explain`` suites
    ask for every call (``?calls=all``); the rest take the default list."""

    name = "mcp"
    OPS = frozenset({"shell", "tool", "bytes", "explain", "cancel", "session"})

    def __init__(self, server: Server, scratch: Path) -> None:
        self.server = server

    def client(self, wid: str, session: str | None, op: str) -> Any:
        query = {"session_id": session} if session else {}
        if op in ALL_CALLS:
            query["calls"] = "all"
        url = f"{self.server.d.url}/v1/workspaces/{wid}/mcp" + (
            f"?{urlencode(query)}" if query else ""
        )
        http = self.server.mcp_client(url)
        return http, Client(streamable_http_client(url, http_client=http))

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        http, client = self.client(wid, session, suite["op"])
        async with http, client:
            return [
                await mcp_case(
                    self.server, client, wid, suite["op"], c["input"]
                )
                for c in suite["cases"]
            ]


class McpStdio(Mcp):
    """MCP over ``mirage mcp``'s stdio."""

    name = "mcp_stdio"

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        argv = self.server.cli(
            "mcp",
            "-w",
            wid,
            *(["-s", session] if session else []),
            *(["--all-calls"] if suite["op"] in ALL_CALLS else []),
        )
        params = StdioServerParameters(
            command=argv[0],
            args=argv[1:],
            env=self.server.env(),
            cwd=str(ROOT),
        )
        async with Client(params) as client:
            return [
                await mcp_case(
                    self.server, client, wid, suite["op"], c["input"]
                )
                for c in suite["cases"]
            ]


async def mcp_case(
    server: Server, client: Any, wid: str, op: str, step: dict[str, Any]
) -> Answer:
    if op in ("shell", "session"):
        tool, arguments = "shell", {"command": step["command"]}
    elif op == "tool":
        tool, arguments = step["tool"], step["arguments"]
    elif op == "explain":
        tool = "shell" if step["call"] == "shell" else f"vfs_{step['call']}"
        result = await client.call_tool(
            tool, {**call_params(step), "explain": True}
        )
        return explain_answer(json.loads(result.content[0].text))
    elif op == "bytes":
        result = await client.call_tool(
            f"vfs_{step['call']}", call_params(step)
        )
        answer = json.loads(result.content[0].text)
        if result.is_error:
            answer = {"errno": answer.get("errno", answer["detail"])}
        return bytes_answer(step, answer)
    elif op == "cancel":
        try:
            await asyncio.wait_for(
                client.call_tool("shell", {"command": step["command"]}), 1
            )
        except TimeoutError:
            pass
        return {
            "text": await server.job_seen(
                wid, step["command"], ("canceled",), 15
            )
        }
    else:
        raise ValueError(op)
    result = await client.call_tool(tool, arguments)
    return {
        "text": result.content[0].text if result.content else "",
        "is_error": bool(result.is_error),
    }


class Rpc:
    """RPC over the HTTP endpoint."""

    name = "rpc"
    OPS = frozenset(
        {"shell", "stdin", "tool", "bytes", "explain", "cancel", "session"}
    )

    def __init__(self, server: Server, scratch: Path) -> None:
        self.server = server

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        params = {"session_id": session} if session else {}
        url = f"/v1/workspaces/{wid}/rpc"
        async with self.server.client() as http:

            async def call(
                method: str, body: dict[str, Any]
            ) -> dict[str, Any]:
                reply = await http.post(
                    url, json=rpc_request(1, method, body), params=params
                )
                reply.raise_for_status()
                return reply.json()

            async def cancel(command: str) -> str:
                running = asyncio.ensure_future(
                    http.post(
                        url,
                        json=rpc_request(7, "shell", {"command": command}),
                        params=params,
                    )
                )
                await self.server.job_seen(wid, command, ("running",), 15)
                await http.post(
                    url,
                    json={
                        "jsonrpc": "2.0",
                        "method": "$/cancelRequest",
                        "params": {"id": 7},
                    },
                    params=params,
                )
                await running
                return await self.server.job_seen(
                    wid, command, ("canceled",), 15
                )

            return [
                await rpc_case(call, cancel, suite["op"], c["input"])
                for c in suite["cases"]
            ]


class RpcStdio(Rpc):
    """RPC over ``mirage rpc``'s stdio."""

    name = "rpc_stdio"

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        session = (suite.get("session") or {}).get("id")
        argv = self.server.cli(
            "rpc", "-w", wid, *(["-s", session] if session else [])
        )
        async with RpcStream(argv, self.server.env()) as stream:

            async def cancel(command: str) -> str:
                await stream.send(
                    rpc_request(900, "shell", {"command": command})
                )
                await self.server.job_seen(wid, command, ("running",), 15)
                await stream.send(
                    {
                        "jsonrpc": "2.0",
                        "method": "$/cancelRequest",
                        "params": {"id": 900},
                    }
                )
                await stream.receive(900)
                return await self.server.job_seen(
                    wid, command, ("canceled",), 15
                )

            return [
                await rpc_case(stream.call, cancel, suite["op"], c["input"])
                for c in suite["cases"]
            ]


async def rpc_case(
    call: Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]],
    cancel: Callable[[str], Awaitable[str]],
    op: str,
    step: dict[str, Any],
) -> Answer:
    if op in ("shell", "session"):
        return io_answer(
            rpc_result(await call("shell", {"command": step["command"]}))
        )
    if op == "stdin":
        data = base64.b64encode(stdin_bytes(step["stdin"])).decode()
        return io_answer(
            rpc_result(
                await call(
                    "shell", {"command": step["command"], "stdin_base64": data}
                )
            )
        )
    if op == "tool":
        return tool_answer(
            rpc_result(
                await call(
                    "tools/call",
                    {"name": step["tool"], "arguments": step["arguments"]},
                )
            )
        )
    if op == "cancel":
        return {"text": await cancel(step["command"])}
    if op == "explain":
        method = "shell" if step["call"] == "shell" else f"vfs/{step['call']}"
        reply = await call(method, {**call_params(step), "explain": True})
        return explain_answer(rpc_result(reply))
    if op != "bytes":
        raise ValueError(op)
    method = "glob" if step["call"] == "glob" else f"vfs/{step['call']}"
    reply = await call(method, call_params(step))
    if "error" in reply:
        data = reply["error"].get("data") or {}
        return bytes_answer(
            step, {"errno": data.get("errno", reply["error"]["message"])}
        )
    return bytes_answer(step, reply["result"])


SSH_OPTIONS = [
    "-F",
    "/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
]


class Ssh:
    """SSH: exec channels, ``sftp`` and ``scp``, with OpenSSH's clients."""

    name = "ssh"
    OPS = frozenset({"shell", "stdin", "bytes", "cancel", "session"})

    def __init__(self, server: Server, scratch: Path) -> None:
        self.server = server
        self.scratch = scratch

    def env(self) -> dict[str, str] | None:
        """The environment ssh, sftp and scp run in; None inherits ours."""
        return None

    async def run(
        self, argv: list[str], stdin: bytes | None = b""
    ) -> tuple[int, str, str]:
        return await run(argv, env=self.env(), stdin=stdin)

    def argv(self, program: str, key: str = "plain") -> list[str]:
        port = "-P" if program in ("sftp", "scp") else "-p"
        return [
            program,
            *SSH_OPTIONS,
            port,
            str(self.server.d.ssh_port),
            "-i",
            str(self.server.d.ssh_key(key)),
        ]

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        wid = prefix.rstrip("-")
        await self.server.provision(suite, wid, config)
        key = "guarded" if suite.get("session") else "plain"
        scratch = self.scratch / prefix
        scratch.mkdir(parents=True, exist_ok=True)
        return [
            await self.case(suite["op"], wid, key, scratch, c["input"])
            for c in suite["cases"]
        ]

    async def case(
        self, op: str, wid: str, key: str, scratch: Path, step: dict[str, Any]
    ) -> Answer:
        login = f"{wid}@127.0.0.1"
        if op in ("shell", "session"):
            code, out, err = await self.run(
                [*self.argv("ssh", key), "-T", login, step["command"]]
            )
            return shell_answer(out, err, code)
        if op == "stdin" and "stream" not in step:
            code, out, err = await self.run(
                [*self.argv("ssh", key), "-T", login, step["command"]],
                stdin=stdin_bytes(step["stdin"]),
            )
            return shell_answer(out, err, code)
        if op == "stdin":
            return await self.stream(login, key, step)
        if op == "bytes":
            return await self.bytes(login, scratch, step)
        if op == "cancel":
            return {"text": await self.interrupt(login, step["command"])}
        raise ValueError(op)

    async def stream(
        self, login: str, key: str, step: dict[str, Any]
    ) -> Answer:
        first, *rest = step["stream"]
        process = await asyncio.create_subprocess_exec(
            *self.argv("ssh", key),
            "-T",
            login,
            step["command"],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env(),
        )
        assert process.stdin is not None
        process.stdin.write(first.encode())
        await process.stdin.drain()
        try:
            await asyncio.wait_for(process.wait(), STREAM_WAIT)
            waited = False
        except TimeoutError:
            waited = True
            process.stdin.write("".join(rest).encode())
            process.stdin.close()
        out, err = await asyncio.wait_for(process.communicate(), 60)
        if waited:
            return {"text": WAITED, "is_error": True}
        return shell_answer(
            out.decode(), err.decode(), process.returncode or 0
        )

    async def sftp(self, login: str, batch: str) -> tuple[int, str, str]:
        return await self.run(
            [*self.argv("sftp"), "-b", "-", login], stdin=batch.encode()
        )

    async def bytes(
        self, login: str, scratch: Path, step: dict[str, Any]
    ) -> Answer:
        call, path = step["call"], step.get("path", "")
        local = scratch / "transfer.bin"
        if call == "write":
            local.write_bytes(base64.b64decode(step["data_base64"]))
            if step.get("via") == "scp":
                code, _, err = await self.run(
                    [*self.argv("scp"), str(local), f"{login}:{path}"]
                )
            else:
                code, _, err = await self.sftp(login, f"put {local} {path}\n")
            return {} if code == 0 else {"error": err.strip()}
        if call == "read":
            local.unlink(missing_ok=True)
            if step.get("via") == "scp":
                code, _, err = await self.run(
                    [*self.argv("scp"), f"{login}:{path}", str(local)]
                )
            else:
                code, _, err = await self.sftp(login, f"get {path} {local}\n")
            if code != 0:
                missing = "not found" in err or "No such file" in err
                return (
                    {"error": "ENOENT"} if missing else {"error": err.strip()}
                )
            return {
                "data_base64": base64.b64encode(local.read_bytes()).decode()
            }
        if call == "stat":
            code, out, err = await self.sftp(login, f"ls -ln {path}\n")
            row = [
                line
                for line in out.splitlines()
                if not line.startswith("sftp>")
            ][0].split()
            return {
                "type": "directory" if row[0].startswith("d") else "file",
                "size": int(row[4]),
            }
        if call == "readdir":
            code, out, err = await self.sftp(login, f"ls -1 {path}\n")
            names = [
                line.strip()
                for line in out.splitlines()
                if line.strip() and not line.startswith("sftp>")
            ]
            return {
                "entries": _entries(
                    path, [n.rsplit("/", 1)[-1] for n in names]
                )
            }
        command = {
            "mkdir": f"mkdir {path}",
            "rename": f"rename {step.get('src')} {step.get('dst')}",
            "unlink": f"rm {path}",
        }[call]
        code, out, err = await self.sftp(login, command + "\n")
        return {} if code == 0 else {"error": err.strip()}

    async def interrupt(self, login: str, command: str) -> str:
        process = await asyncio.create_subprocess_exec(
            *self.argv("ssh"),
            "-tt",
            login,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**(self.env() or os.environ), "TERM": "xterm"},
        )
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(f"{command}\n".encode())
        await process.stdin.drain()
        await asyncio.sleep(1)
        process.stdin.write(b"\x03")
        await process.stdin.drain()
        await asyncio.sleep(0.5)
        process.stdin.write(b"echo status=$?\nexit\n")
        await process.stdin.drain()
        try:
            out, _ = await asyncio.wait_for(process.communicate(), 20)
        except TimeoutError:
            process.kill()
            return "the shell never came back"
        text = out.decode(errors="replace")
        return (
            "canceled"
            if "status=130" in text
            else f"no interrupt: {text[-200:]!r}"
        )


class SshProxy(Ssh):
    """SSH over the HTTPS route: ``mirage ssh-proxy`` is ssh's ProxyCommand.

    The CLI's token logs in, so there is no key and no SSH port; on
    ``jwt`` it is an OAuth access token, as a CLI that logged in through
    the issuer holds. The tunnel runs under the workspace's default
    profile, so the session suite, which binds a key to a profile, is
    not its.
    """

    name = "ssh_proxy"
    OPS = frozenset({"shell", "stdin", "bytes", "cancel"})

    def __init__(self, server: Server, scratch: Path) -> None:
        super().__init__(server, scratch)
        d = server.d
        self.token = d.issuer.oauth_token() if d.name == "jwt" else None

    def env(self) -> dict[str, str] | None:
        return self.server.env(self.token)

    def argv(self, program: str, key: str = "plain") -> list[str]:
        proxy = shlex.join(self.server.cli("ssh-proxy", "%r"))
        return [program, *SSH_OPTIONS, "-o", f"ProxyCommand={proxy}"]

    async def suite(
        self, suite: dict[str, Any], prefix: str, config: dict[str, Any]
    ) -> list[Answer]:
        await self.reach_route()
        return await super().suite(suite, prefix, config)

    async def reach_route(self) -> None:
        """Open the SSH route as the proxy does, and record it only once
        the server's SSH banner comes back over it."""
        d = self.server.d
        route = f"/v1/workspaces/{SEED}/ssh"
        token = self.token or d.bearer()
        async with websockets.connect(
            f"ws://127.0.0.1:{d.port}{route}",
            additional_headers={"Authorization": f"Bearer {token}"},
        ) as ws:
            banner = await asyncio.wait_for(ws.recv(), 10)
        raw = banner.encode() if isinstance(banner, str) else bytes(banner)
        if raw.startswith(b"SSH-"):
            seen = self.server.recorder.requests.setdefault(
                self.server.key, set()
            )
            seen.add(("GET", route))


def server_accesses(server: Server, scratch: Path) -> list[Any]:
    return [
        cls(server, scratch)
        for cls in (Http, Cli, Mcp, McpStdio, Rpc, RpcStdio, Ssh, SshProxy)
    ]
