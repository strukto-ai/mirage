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
"""Every access to a workspace, under every deployment, on both hosts.

Run from the repository root after building the TypeScript packages:
    ./python/.venv/bin/python integ/access/run.py

The corpus (cases.json) runs in-app first on each host; every case pins
the in-app answer. Then each deployment starts on each host (``dev``,
the CLI's own daemon; ``token`` and ``jwt``, the server as a service
runs it) and every access that has a suite's operation runs the suite
on a fresh workspace and must give the in-app answers. Auth is checked
per deployment: every credential over HTTP, and a good and a bad one
through each other access. ``dev`` adds the CLI's lifecycle: spawning,
status, restart, stop, kill, idle exit, config, the stdio relays, and a
remote URL that must neither start a daemon nor receive the token file.

Three gates end a run over both hosts and every access: every HTTP
route was hit on each host and deployment run (the two hosts' route
tables must match), every CLI command ran on both hosts when ``dev`` is
among them (the two CLIs' commands must match), and the ops table
matches the adapters and the overview's matrix.

``--deployment`` picks deployments, one per CI leg. ``--access`` and
``--host`` narrow a run further and skip the route and command gates;
``--print`` prints the in-app answers for pinning.
"""

import argparse
import asyncio
import json
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
from adapters import (
    SSH_OPTIONS,
    Answer,
    Cli,
    Http,
    InAppPython,
    InAppTypeScript,
    Mcp,
    McpStdio,
    Recorder,
    Rpc,
    RpcStdio,
    RpcStream,
    Server,
    Ssh,
    SshProxy,
    io_answer,
    run,
    server_accesses,
)
from deploy import (
    DEPLOYMENTS,
    HOSTS,
    INTEG,
    ROOT,
    SEED,
    STORE_DEPLOYMENTS,
    TOKEN,
    Deployment,
    SnapshotStore,
    clean_env,
    deployed,
    free_port,
    mirage_cli,
    snapshot_store,
)
from issuer import Issuer
from starlette.routing import WebSocketRoute

from mirage.server.app import build_app

CASES = json.loads(Path(__file__).with_name("cases.json").read_text())
OVERVIEW = ROOT / "docs" / "home" / "access" / "overview.mdx"
COLUMNS = {
    "In-app": ("inapp",),
    "HTTP": ("http",),
    "MCP": ("mcp", "mcp_stdio"),
    "RPC": ("rpc", "rpc_stdio"),
    "CLI": ("cli",),
    "SSH": ("ssh", "ssh_proxy"),
}
ACCESSES = (
    "inapp",
    "http",
    "cli",
    "mcp",
    "mcp_stdio",
    "rpc",
    "rpc_stdio",
    "ssh",
    "ssh_proxy",
)


class Report:
    """Collects every check and prints the failures."""

    def __init__(self) -> None:
        self.passed = 0
        self.failures: list[str] = []

    def check(self, label: str, got: Any, want: Any) -> None:
        if got == want:
            self.passed += 1
            return
        self.failures.append(f"{label}: got {got!r}, want {want!r}")
        print(f"FAIL {label}: got {got!r}, want {want!r}", flush=True)

    def note(self, label: str) -> None:
        print(f"ok   {label}", flush=True)


def config_of(suite: dict[str, Any]) -> dict[str, Any]:
    return suite.get("workspace") or CASES["workspace"]


def suites_for(access: str) -> list[dict[str, Any]]:
    return [s for s in CASES["suites"] if access in CASES["ops"][s["op"]]]


def compare(
    report: Report,
    label: str,
    suite: dict[str, Any],
    access: str,
    answers: list[Answer],
) -> None:
    before = len(report.failures)
    for case, answer in zip(suite["cases"], answers, strict=True):
        want = case.get("expect_by_access", {}).get(access, case.get("expect"))
        report.check(f"{label} {suite['id']}.{case['id']}", answer, want)
    if len(report.failures) == before:
        report.note(f"{label} {suite['id']} ({len(answers)} cases)")


def runnable(suite: dict[str, Any], access: str) -> dict[str, Any]:
    cases = [
        c for c in suite["cases"] if access in c.get("accesses", ACCESSES)
    ]
    return {**suite, "cases": cases}


async def in_app(
    host: str,
    scratch: Path,
    store: SnapshotStore,
    report: Report,
    printing: bool,
) -> None:
    access = (
        InAppPython(scratch, store.config(host))
        if host == "python"
        else InAppTypeScript(scratch, store.config(host))
    )
    pinned: dict[str, list[Answer]] = {}
    for suite in suites_for("inapp"):
        run_suite = runnable(suite, "inapp")
        answers = await access.suite(
            run_suite, f"{suite['id']}-inapp-", config_of(suite)
        )
        pinned[suite["id"]] = answers
        if not printing:
            compare(report, f"{host} inapp", run_suite, "inapp", answers)
    if printing:
        print(json.dumps(pinned, indent=1, ensure_ascii=False))


async def through_accesses(
    server: Server, scratch: Path, wanted: set[str], report: Report
) -> None:
    for access in server_accesses(server, scratch):
        if access.name not in wanted:
            continue
        for suite in suites_for(access.name):
            if server.d.name not in suite.get("deployments", DEPLOYMENTS):
                continue
            run_suite = runnable(suite, access.name)
            prefix = f"{suite['id']}-{access.name}-"
            started = time.monotonic()
            try:
                answers = await access.suite(
                    run_suite, prefix, config_of(suite)
                )
            except Exception as exc:
                report.check(
                    f"{server.key} {access.name} {suite['id']}",
                    repr(exc),
                    "answers",
                )
                continue
            took = f"{time.monotonic() - started:.1f}s"
            compare(
                report,
                f"{server.key} {access.name} [{took}]",
                run_suite,
                access.name,
                answers,
            )


def credentials(d: Deployment, issuer: Issuer) -> dict[str, str | None]:
    found: dict[str, str | None] = {
        "none": None,
        "other_token": "some-other-token",
        "fixed_token": TOKEN,
        "jwt_valid": issuer.token(),
        "oauth_valid": issuer.oauth_token(),
        **issuer.bad(),
    }
    if d.name == "dev":
        found["local_token"] = d.bearer()
    return found


async def access_auth(server: Server, access: str, token: str) -> str:
    """Whether one access gets in with ``token``.

    Args:
        server (Server): the deployment.
        access (str): the access.
        token (str): the bearer token, or for SSH ``plain`` or ``unknown``.

    Returns:
        str: ``ok`` or ``refused``.
    """
    d = server.d
    if access == "cli":
        code, _, _ = await run(
            server.cli("workspace", "list"), server.env(token)
        )
        return "ok" if code == 0 else "refused"
    if access == "rpc":
        async with server.client(token) as http:
            reply = await http.post(
                f"/v1/workspaces/{SEED}/rpc",
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {},
                },
            )
            return "ok" if reply.status_code == 200 else "refused"
    if access == "rpc_stdio":
        try:
            async with RpcStream(
                server.cli("rpc", "-w", SEED), server.env(token)
            ) as stream:
                reply = await asyncio.wait_for(
                    stream.call("initialize", {}), 30
                )
            return "ok" if "result" in reply else "refused"
        except (RuntimeError, TimeoutError):
            return "refused"
    if access in ("mcp", "mcp_stdio"):
        from mcp import Client, StdioServerParameters
        from mcp.client.streamable_http import streamable_http_client

        async def connect() -> None:
            if access == "mcp":
                url = f"{d.url}/v1/workspaces/{SEED}/mcp"
                async with (
                    server.mcp_client(url, token) as http,
                    Client(
                        streamable_http_client(url, http_client=http)
                    ) as client,
                ):
                    await client.list_tools()
                return
            argv = server.cli("mcp", "-w", SEED)
            params = StdioServerParameters(
                command=argv[0],
                args=argv[1:],
                env=server.env(token),
                cwd=str(ROOT),
            )
            async with Client(params) as client:
                await client.list_tools()

        try:
            await asyncio.wait_for(connect(), 20)
            return "ok"
        except (Exception, TimeoutError):
            return "refused"
    if access == "ssh_proxy":
        proxy = SshProxy(server, Path(tempfile.mkdtemp()))
        proxy.token = token
        code, _, _ = await proxy.run(
            [*proxy.argv("ssh"), "-T", f"{SEED}@127.0.0.1", "true"]
        )
        return "ok" if code == 0 else "refused"
    key = "plain" if token == "plain" else "unknown"
    ssh = [
        "ssh",
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
        "-p",
        str(d.ssh_port),
        "-i",
        str(d.ssh_key(key)),
    ]
    code, _, _ = await run([*ssh, "-T", f"{SEED}@127.0.0.1", "true"])
    return "ok" if code == 0 else "refused"


async def auth(
    server: Server, issuer: Issuer, wanted: set[str], report: Report
) -> None:
    d = server.d
    if "http" in wanted:
        creds = credentials(d, issuer)
        async with httpx.AsyncClient(
            base_url=d.url,
            timeout=30,
            event_hooks={"request": [server.recorder.hook(server.key)]},
        ) as http:
            for name, want in CASES["auth"]["http"][d.name].items():
                token = creds[name]
                headers = (
                    {}
                    if token is None
                    else {"Authorization": f"Bearer {token}"}
                )
                reply = await http.get("/v1/workspaces", headers=headers)
                report.check(
                    f"{server.key} auth.http.{name}", reply.status_code, want
                )
        report.note(f"{server.key} auth.http")
    for access in CASES["ops"]["auth"]:
        if access == "http" or access not in wanted:
            continue
        valid, wrong = (
            ("plain", "unknown")
            if access == "ssh"
            else (d.bearer(), "some-other-token")
        )
        got = {
            "valid": await access_auth(server, access, valid),
            "wrong": await access_auth(server, access, wrong),
        }
        report.check(
            f"{server.key} auth.{access}", got, CASES["auth"]["accesses"]
        )
        report.note(f"{server.key} auth.{access}")


async def login(server: Server, scratch: Path, report: Report) -> None:
    """``mirage login``, ``whoami`` and ``logout`` against one deployment.

    The CLI gets a home of its own and no token, so the login is all it
    has. On ``jwt`` the browser is a user already signed in to the
    issuer; the login then drives the CLI and SSH through
    ``ssh-proxy``, refreshes its ended token, and ends after 30 days.

    Args:
        server (Server): the deployment.
        scratch (Path): a directory for the CLI's home and browser.
        report (Report): where the checks go.
    """
    d = server.d
    home = scratch / "home"
    home.mkdir(parents=True, exist_ok=True)
    browser = scratch / "browser"
    browser.write_text(
        "#!/bin/sh\nexec "
        + shlex.join([sys.executable, str(INTEG / "access" / "browser.py")])
        + ' "$1"\n'
    )
    browser.chmod(0o755)
    env = {**d.cli_env(), "MIRAGE_HOME": str(home), "BROWSER": str(browser)}
    env.pop("MIRAGE_TOKEN", None)
    stored = home / "login.json"

    async def cli(*args: str) -> tuple[int, str, str]:
        return await run(server.cli(*args), env)

    async def lists() -> str:
        code, _, err = await cli("workspace", "list")
        return (
            "ok" if code == 0 else err.strip().splitlines()[-1].split(";")[0]
        )

    got: dict[str, Any] = {}
    async with httpx.AsyncClient(
        base_url=d.url,
        timeout=30,
        event_hooks={"request": [server.recorder.hook(server.key)]},
    ) as http:
        found = await http.get("/.well-known/oauth-protected-resource")
        got["resource"] = found.status_code
    _, out, _ = await cli("login")
    got["login"] = out.strip().replace(d.url, "{url}")
    if d.name == "token":
        got["login_wrong_token"], _, _ = await cli(
            "login", "--token", "some-other-token"
        )
        got["login_token"], _, _ = await cli("login", "--token", TOKEN)
    code, out, _ = await cli("whoami")
    got["whoami"] = json.loads(out)["account"] if code == 0 else code
    if stored.exists():
        got["list"] = await lists()
    if d.name == "jwt":
        proxy = shlex.join(server.cli("ssh-proxy", "%r"))
        code, _, _ = await run(
            ["ssh", *SSH_OPTIONS, "-o", f"ProxyCommand={proxy}"]
            + [f"{SEED}@mirage", "true"],
            env,
        )
        got["ssh_proxy"] = code
        kept = json.loads(stored.read_text())
        stored.write_text(json.dumps({**kept, "expires_at": time.time() - 1}))
        got["ended_token"] = await lists()
        got["refreshed"] = (
            json.loads(stored.read_text())["access_token"]
            != kept["access_token"]
        )
        month = time.time() - 31 * 24 * 60 * 60
        stored.write_text(
            json.dumps(
                {**json.loads(stored.read_text()), "logged_in_at": month}
            )
        )
        got["after_30_days"] = await lists()
    _, out, _ = await cli("logout")
    got["logout"] = out.strip().replace(d.url, "{url}")
    if d.name != "dev":
        got["after_logout"] = await lists()
    for key, want in CASES["login"][d.name].items():
        report.check(f"{server.key} login.{key}", got.get(key), want)


async def cross_host(
    server: Server, recorder: Recorder, report: Report
) -> None:
    other = "typescript" if server.host == "python" else "python"
    recorder.command(other, ("shell",))
    argv = mirage_cli(other, "shell", "-w", SEED, "-c", "echo cross")
    code, out, err = await run(argv, server.env(), tty=True)
    got = (
        io_answer(json.loads(out))
        if out.strip()
        else {"text": err, "is_error": True}
    )
    report.check(
        f"{server.key} cross_host.{other}_cli",
        got,
        {"text": "cross\n", "is_error": False},
    )


async def server_checks(server: Server, report: Report) -> None:
    d = server.d
    want = CASES["server"]
    async with httpx.AsyncClient(
        base_url=d.url,
        timeout=30,
        event_hooks={"request": [server.recorder.hook(server.key)]},
    ) as http:
        report.check(
            f"{server.key} server.health_without_token",
            (await http.get("/v1/health")).status_code,
            want["health_without_token"],
        )
        evil = await http.get("/v1/health", headers={"Host": "evil.example"})
        report.check(
            f"{server.key} server.unknown_host",
            evil.status_code,
            want["unknown_host"],
        )
        auth = {"Authorization": f"Bearer {d.bearer()}"}
        mcp = f"/v1/workspaces/{SEED}/mcp"
        got = {}
        for method in ("GET", "DELETE"):
            async with http.stream(method, mcp, headers=auth) as reply:
                got[method.lower()] = reply.status_code
        report.check(
            f"{server.key} server.mcp_methods", got, want["mcp_methods"]
        )
        if d.name not in STORE_DEPLOYMENTS:
            refused = await http.post(
                f"/v1/workspaces/{SEED}/snapshot",
                json={"key": "seed.tar"},
                headers=auth,
            )
            report.check(
                f"{server.key} server.no_snapshot_store",
                [refused.status_code, refused.json().get("detail")],
                want["no_snapshot_store"],
            )
        stop = await http.post("/v1/shutdown", headers=auth)
        report.check(
            f"{server.key} server.shutdown",
            stop.status_code,
            want["shutdown"][d.name],
        )
    deadline = time.monotonic() + 15
    state = "serving"
    while time.monotonic() < deadline:
        if not d.ready():
            state = "exited"
            break
        if d.name != "dev" and time.monotonic() > deadline - 13:
            break
        await asyncio.sleep(0.2)
    report.check(
        f"{server.key} server.after_shutdown",
        state,
        want["after_shutdown"][d.name],
    )


async def capture_token(
    port: int, seen: list[str]
) -> asyncio.base_events.Server:
    """A stand-in remote server that records the Authorization it gets."""

    async def answer(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        head = (await reader.readuntil(b"\r\n\r\n")).decode(errors="replace")
        found = [
            line.split(":", 1)[1].strip()
            for line in head.split("\r\n")
            if line.lower().startswith("authorization:")
        ]
        seen.append(found[0] if found else "")
        writer.write(
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
            b"content-length: 2\r\nconnection: close\r\n\r\n[]"
        )
        await writer.drain()
        writer.close()

    return await asyncio.start_server(
        answer, host=["127.0.0.1", "::1"], port=port
    )


async def lifecycle(
    host: str, root: Path, recorder: Recorder, report: Report
) -> None:
    """The CLI's own daemon: spawn, status, restart, stop, kill, idle exit,
    config, the stdio relays, and a remote URL.

    Args:
        host (str): ``python`` or ``typescript``.
        root (Path): a private directory.
        recorder (Recorder): where the commands run go.
        report (Report): the report.
    """
    from deploy import RAM, ssh_keys
    from mcp import Client, StdioServerParameters

    root.mkdir(parents=True, exist_ok=True)
    ssh_keys(root)
    port, ssh_port = free_port(), free_port()
    url = f"http://127.0.0.1:{port}"
    home = root / "home"
    env = {
        **clean_env(),
        "MIRAGE_HOME": str(home),
        "MIRAGE_DAEMON_URL": url,
        "MIRAGE_DAEMON_PORT": str(port),
        "MIRAGE_IDLE_GRACE_SECONDS": "600",
        "MIRAGE_SSH_PORT": str(ssh_port),
        "MIRAGE_SSH_HOST_KEY_FILE": str(root / "host_key"),
        "MIRAGE_SSH_AUTHORIZED_KEYS": str(root / "authorized_keys"),
    }
    config = root / "ram.yaml"
    config.write_text(RAM)
    got: dict[str, str] = {}

    async def cli(
        *args: str, use: dict[str, str] | None = None, tty: bool = False
    ) -> tuple[int, str, str]:
        recorder.command(host, args)
        return await run(mirage_cli(host, *args), use or env, tty=tty)

    def alive(at: str = url) -> bool:
        try:
            return httpx.get(f"{at}/v1/health", timeout=1).status_code == 200
        except httpx.TransportError:
            return False

    async def gone(at: str = url, timeout: float = 15) -> bool:
        deadline = time.monotonic() + timeout
        while alive(at):
            if time.monotonic() > deadline:
                return False
            await asyncio.sleep(0.2)
        return True

    def ids() -> list[str]:
        token = (home / "auth_token").read_text().strip()
        return sorted(
            w["id"]
            for w in httpx.get(
                f"{url}/v1/workspaces",
                headers={"Authorization": f"Bearer {token}"},
            ).json()
        )

    code, _, _ = await cli("daemon", "status")
    got["status_without_daemon"] = str(code)
    code, _, _ = await cli("workspace", "list")
    got["list_without_daemon"] = (
        f"{code} {'started' if alive() else 'not started'}"
    )
    code, _, err = await cli("workspace", "create", str(config), "--id", "a")
    got["create_starts_the_daemon"] = f"{code} {'running' if alive() else err}"
    code, out, _ = await cli("daemon", "status")
    status = json.loads(out)
    got["status_reports"] = (
        f"running={status['running']} workspaces={status['workspaces']}"
    )
    ssh = [
        "ssh",
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
        "-p",
        str(ssh_port),
        "-i",
        str(root / "id_plain"),
    ]
    _, out, _ = await run([*ssh, "-T", "a@127.0.0.1", "echo ok"])
    got["ssh_is_on"] = out
    await cli("daemon", "restart")
    got["restart_stops"] = "running" if alive() else "stopped"
    await cli("workspace", "create", str(config), "--id", "b")
    got["restart_drops_workspaces"] = " ".join(ids())
    await cli("daemon", "restart", "--eager")
    got["restart_eager"] = (
        f"{'running' if alive() else 'stopped'} {len(ids()) if alive() else '-'}"
    )
    await cli("daemon", "stop")
    code, _, _ = await cli("daemon", "status")
    got["stop"] = f"{code} {'stopped' if not alive() else 'running'}"
    await cli("workspace", "create", str(config), "--id", "c")
    await cli("daemon", "kill")
    got["kill"] = "killed" if await gone() else "still running"
    idle = {**env, "MIRAGE_IDLE_GRACE_SECONDS": "1"}
    await cli("workspace", "create", str(config), "--id", "d", use=idle)
    await cli("workspace", "delete", "d", use=idle)
    got["idle_exit"] = "exited" if await gone() else "still running"

    await cli("workspace", "create", str(config), "--id", "e")
    unnamed = root / "unnamed.yaml"
    unnamed.write_text(RAM)
    argv = mirage_cli(host, "mcp", str(unnamed))
    recorder.command(host, ("mcp",))
    async with Client(
        StdioServerParameters(
            command=argv[0], args=argv[1:], env=env, cwd=str(ROOT)
        )
    ) as client:
        await client.list_tools()
        during = len(ids())
    deadline = time.monotonic() + 15
    while len(ids()) != 1 and time.monotonic() < deadline:
        await asyncio.sleep(0.2)
    got["mcp_unnamed"] = f"{during} {len(ids())}"
    named = root / "named.yaml"
    named.write_text(
        '{"workspace_id": "named", "mounts": {"/": {"vfs": "ram", "mode": "write"}}}\n'
    )
    argv = mirage_cli(host, "mcp", str(named))
    for _ in range(2):
        async with Client(
            StdioServerParameters(
                command=argv[0], args=argv[1:], env=env, cwd=str(ROOT)
            )
        ) as client:
            await client.call_tool("shell", {"command": "echo kept >> /k"})
    _, out, _ = await cli("shell", "-w", "named", "-c", "cat /k", tty=True)
    got["mcp_named"] = json.loads(out)["stdout"]
    code, _, _ = await cli("mcp", "-w", "e", "-s", "nope")
    got["mcp_unknown_session"] = str(code)
    async with RpcStream(mirage_cli(host, "rpc", str(unnamed)), env) as stream:
        reply = await stream.call("initialize", {})
        during = len(ids())
    deadline = time.monotonic() + 15
    while len(ids()) != during - 1 and time.monotonic() < deadline:
        await asyncio.sleep(0.2)
    got["rpc_unnamed"] = (
        f"{'initialized' if 'result' in reply else reply} {during - len(ids())} gone"
    )

    _, out, _ = await cli("config", "set", "idle_grace_seconds", "45")
    _, out, _ = await cli("config", "get", "idle_grace_seconds")
    got["config_set_get"] = str(json.loads(out)["idle_grace_seconds"])
    _, out, _ = await cli(
        "config",
        "list",
        "--resolved",
        use={
            **env,
            "MIRAGE_IDLE_GRACE_SECONDS": "9",
            "MIRAGE_TOKEN": "secret",
        },
    )
    resolved = json.loads(out)
    grace = resolved["idle_grace_seconds"]
    got["config_env_wins"] = f"{grace['value']} {grace['origin']}"
    got["config_token_masked"] = str(resolved["auth_token"]["value"])
    await cli("config", "unset", "idle_grace_seconds")
    code, _, _ = await cli("config", "get", "idle_grace_seconds")
    got["config_unset"] = str(code)
    code, _, _ = await cli("config", "set", "typo_key", "1")
    got["config_unknown_key"] = str(code)
    await cli("daemon", "stop")
    moved = free_port()
    plain = {
        k: v
        for k, v in env.items()
        if k not in ("MIRAGE_DAEMON_URL", "MIRAGE_DAEMON_PORT")
    }
    await cli("config", "set", "url", f"http://127.0.0.1:{moved}", use=plain)
    await cli("config", "set", "port", str(moved), use=plain)
    await cli("config", "set", "allowed_hosts", "127.0.0.1", use=plain)
    hosts = {
        **plain,
        "MIRAGE_ALLOWED_HOSTS": "127.0.0.1,localhost,evil.example",
    }
    await cli("workspace", "create", str(config), "--id", "f", use=hosts)
    got["config_port_moves"] = (
        "answers" if alive(f"http://127.0.0.1:{moved}") else "silent"
    )
    evil = httpx.get(
        f"http://127.0.0.1:{moved}/v1/health",
        headers={"Host": "evil.example"},
        timeout=5,
    )
    got["allowed_hosts_env_wins"] = str(evil.status_code)
    await cli("daemon", "stop", use=hosts)
    for key in ("url", "port", "allowed_hosts"):
        await cli("config", "unset", key, use=plain)
    (home / "config.toml").write_text("[daemon\n")
    code, _, _ = await cli("workspace", "create", str(config), "--id", "g")
    got["config_malformed"] = str(code)
    (home / "config.toml").write_text("")

    remote = {**env, "MIRAGE_DAEMON_URL": "http://mirage.invalid:8765"}
    code, _, _ = await cli(
        "workspace", "create", str(config), "--id", "h", use=remote
    )
    got["remote_never_spawns"] = (
        f"{code} {'started' if alive() else 'not started'}"
    )
    capture_port = free_port()
    seen: list[str] = []
    capture = await capture_token(capture_port, seen)
    try:
        await cli(
            "workspace",
            "list",
            use={
                **env,
                "MIRAGE_DAEMON_URL": f"http://localhost.:{capture_port}",
            },
        )
    finally:
        capture.close()
        await capture.wait_closed()
    got["remote_gets_no_token_file"] = (
        "no token sent" if seen and not any(seen) else f"sent {seen!r}"
    )

    await cli("workspace", "create", str(config), "--id", "i")
    tty_code, _, _ = await cli("shell", "-w", "i", "-c", "exit 3", tty=True)
    piped_code, _, _ = await cli("shell", "-w", "i", "-c", "exit 3")
    got["shell_exit_status"] = f"{tty_code} {piped_code}"
    code, _, _ = await cli("workspace", "get", "nope")
    got["unknown_workspace"] = str(code)
    code, _, _ = await cli("workspace", "load", "--key", "ghost.tar")
    got["no_snapshot_store"] = str(code)
    taken = root / "taken.yaml"
    taken.write_text(
        '{"workspace_id": "i", "mounts": {"/": {"vfs": "ram", "mode": "read"}}}\n'
    )
    code, _, err = await cli("mcp", str(taken))
    got["mcp_name_taken"] = (
        f"{code} {'already exists' if 'already exists' in err else err.strip()[-120:]}"
    )
    interpolated = root / "interpolated.yaml"
    interpolated.write_text(
        "mounts:\n  /:\n    vfs: ram\n    mode: ${MOUNT_MODE_FROM_ENV}\n"
    )
    await cli(
        "workspace",
        "create",
        str(interpolated),
        "--id",
        "j",
        use={**env, "MOUNT_MODE_FROM_ENV": "write"},
    )
    _, out, _ = await cli("workspace", "get", "j")
    got["config_interpolates_cli_env"] = " ".join(
        m["mode"] for m in json.loads(out)["mounts"] if m["prefix"] == "/"
    )
    code, _, _ = await cli(
        "workspace", "create", str(interpolated), "--id", "k"
    )
    got["missing_variable_fails_first"] = (
        f"{code} {'created' if 'k' in ids() else 'not created'}"
    )
    await cli("daemon", "stop")

    for key, want in CASES["lifecycle"].items():
        report.check(f"{host} lifecycle.{key}", got.get(key), want)


def python_routes() -> set[tuple[str, str]]:
    found = set()
    for route in build_app().routes:
        methods = getattr(route, "methods", None) or (
            ("GET",) if isinstance(route, WebSocketRoute) else ()
        )
        for method in methods:
            if method not in ("HEAD", "OPTIONS") and route.path.startswith(
                ("/v1", "/.well-known")
            ):
                found.add((method, re.sub(r"\{[^}]+\}", "{}", route.path)))
    return found


def typescript_routes() -> set[tuple[str, str]]:
    out = subprocess.run(
        ["node", "--import", "tsx", "access/serve.ts", "--routes"],
        cwd=ROOT / "integ",
        env={**clean_env(), "MIRAGE_HOME": tempfile.mkdtemp()},
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stdout
    lines = json.loads(out.strip().splitlines()[-1])
    found: set[tuple[str, str]] = set()
    stack: list[str] = []
    for line in lines:
        match = re.match(
            r"^((?:│   |    )*)(?:├── |└── )(\S+) \(([^)]*)\)", line
        )
        if not match:
            continue
        depth = len(match.group(1)) // 4
        stack = stack[:depth] + [re.sub(r":[^/]+", "{}", match.group(2))]
        path = "".join(stack)
        for method in match.group(3).split(", "):
            if method not in ("HEAD", "OPTIONS"):
                found.add((method, path))
    return found


def gate_routes(recorder: Recorder, keys: list[str], report: Report) -> None:
    py, ts = python_routes(), typescript_routes()
    report.check("routes.python_equals_typescript", sorted(py ^ ts), [])
    for key in keys:
        hits = recorder.requests.get(key, set())
        missing = []
        for method, path in sorted(py):
            pattern = "^" + re.escape(path).replace(r"\{\}", "[^/]+") + "$"
            if not any(m == method and re.match(pattern, p) for m, p in hits):
                missing.append(f"{method} {path}")
        report.check(f"{key} routes.missing", missing, [])


def python_commands() -> set[str]:
    from typer.main import get_command

    from mirage.cli.main import app

    def walk(command: Any, words: list[str]) -> list[str]:
        subs = getattr(command, "commands", None)
        if not subs:
            return [" ".join(words)]
        return [
            leaf
            for name, sub in subs.items()
            for leaf in walk(sub, [*words, name])
        ]

    return set(walk(get_command(app), []))


def typescript_commands() -> set[str]:
    def listed(*words: str) -> list[str]:
        out = subprocess.run(
            mirage_cli("typescript", *words, "--help"),
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
        names, inside = [], False
        for line in out.splitlines():
            if line.startswith("Commands:"):
                inside = True
                continue
            command = re.match(r"^  (\S+)", line) if inside else None
            if command and command.group(1) != "help":
                names.append(command.group(1).split("|")[0])
            elif inside and not line.strip():
                inside = False
        return names

    found = set()
    for name in listed():
        subs = listed(name)
        found |= {f"{name} {s}" for s in subs} if subs else {name}
    return found


def gate_commands(
    recorder: Recorder, hosts: list[str], report: Report
) -> None:
    py, ts = python_commands(), typescript_commands()
    report.check("cli.python_equals_typescript", sorted(py ^ ts), [])
    for host in hosts:
        missing = sorted(py - recorder.commands.get(host, set()))
        report.check(f"{host} cli.missing", missing, [])


def gate_ops(report: Report) -> None:
    table = CASES["ops"]
    implemented = {
        cls.name: cls.OPS
        for cls in (
            InAppPython,
            Http,
            Cli,
            Mcp,
            McpStdio,
            Rpc,
            RpcStdio,
            Ssh,
            SshProxy,
        )
    }
    report.check("ops.inapp_hosts_match", InAppTypeScript.OPS, InAppPython.OPS)
    for access, ops in implemented.items():
        listed = {
            op
            for op, accesses in table.items()
            if access in accesses and op not in ("auth", "server")
        }
        report.check(f"ops.{access}", sorted(ops), sorted(listed))
    covered = {s["op"] for s in CASES["suites"]}
    report.check(
        "ops.every_op_has_a_suite",
        sorted(set(table) - covered - {"auth", "server"}),
        [],
    )
    rows: dict[str, list[str]] = {}
    header: list[str] = []
    for line in OVERVIEW.read_text().splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if cells[0] == "" and "In-app" in cells:
            header = cells
        elif (
            header
            and len(cells) == len(header)
            and not set(cells[0]) <= {"-", " "}
        ):
            rows[cells[0]] = cells
    for label, op in CASES["matrix"].items():
        cells = rows.get(label)
        if cells is None:
            report.check(f"ops.matrix.{label}", "missing row", "a row")
            continue
        shown = set()
        for column, cell in zip(header[1:], cells[1:], strict=True):
            if cell not in ("–", "-") and not cell.startswith("via"):
                shown |= set(COLUMNS[column])
        report.check(
            f"ops.matrix.{label}", sorted(shown), sorted(set(table[op]))
        )


async def main(args: argparse.Namespace) -> int:
    report = Report()
    hosts = args.host or list(HOSTS)
    deployments = args.deployment or list(DEPLOYMENTS)
    wanted = set(args.access or ACCESSES)
    full = not (args.host or args.access)
    if args.print:
        with (
            tempfile.TemporaryDirectory(prefix="mirage-access-") as tmp,
            snapshot_store() as store,
        ):
            await in_app(hosts[0], Path(tmp), store, report, printing=True)
        return 0
    gate_ops(report)
    recorder = Recorder()
    issuer = Issuer()
    keys: list[str] = []
    with (
        tempfile.TemporaryDirectory(prefix="mirage-access-") as tmp,
        snapshot_store() as store,
        issuer.serving(),
    ):
        for host in hosts:
            scratch = Path(tmp) / host
            if "inapp" in wanted:
                await in_app(
                    host, scratch / "inapp", store, report, printing=False
                )
            if wanted == {"inapp"}:
                continue
            for name in deployments:
                with deployed(name, host, scratch / name, issuer, store) as d:
                    server = Server(d, recorder)
                    keys.append(server.key)
                    await through_accesses(
                        server, scratch / name / "scratch", wanted, report
                    )
                    await auth(server, issuer, wanted, report)
                    if "cli" in wanted:
                        await login(server, scratch / name / "login", report)
                    if name != "dev" and "cli" in wanted:
                        await cross_host(server, recorder, report)
                    await server_checks(server, report)
            if "dev" in deployments and "cli" in wanted:
                await lifecycle(host, scratch / "lifecycle", recorder, report)
        if full and keys:
            gate_routes(recorder, keys, report)
        if full and "dev" in deployments:
            gate_commands(recorder, hosts, report)
    print(f"{report.passed} passed, {len(report.failures)} failed")
    return 1 if report.failures else 0


def parse() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", action="append", choices=HOSTS)
    parser.add_argument("--deployment", action="append", choices=DEPLOYMENTS)
    parser.add_argument("--access", action="append", choices=ACCESSES)
    parser.add_argument(
        "--print",
        action="store_true",
        help="print the in-app answers for pinning",
    )
    return parser.parse_args()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(parse())))
