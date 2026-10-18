import argparse
import asyncio
import base64
import json
import logging
import os
import random
import signal
import socket
import sys
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SHELL = "/v1/workspaces/interrupt/shell"
TERMINAL = {"done", "failed", "canceled"}
BOUNDARY = b"mirage-interrupt"


async def checked(client, method, path, **kwargs):
    response = await client.request(method, path, **kwargs)
    response.raise_for_status()
    return response.json()


async def shell(client, command, **kwargs):
    return await checked(
        client,
        "POST",
        SHELL,
        json={"command": command, "record": False},
        **kwargs,
    )


async def healthy(client):
    await checked(client, "GET", "/v1/health")
    peer = await shell(client, "echo alive", params={"session_id": "peer"})
    assert peer["stdout"] == "alive\n", peer


async def settled(client, job_id, canceled=True):
    async with asyncio.timeout(3):
        while True:
            job = await checked(client, "GET", f"/v1/jobs/{job_id}")
            if job["status"] in TERMINAL:
                break
            await asyncio.sleep(0.025)
    if canceled:
        assert job["status"] == "canceled", job
    await healthy(client)
    return job


async def cancel(client, job_id, required=True):
    await checked(client, "DELETE", f"/v1/jobs/{job_id}")
    return await settled(client, job_id, required)


async def find_job(client, command):
    async with asyncio.timeout(3):
        while True:
            jobs = await checked(
                client, "GET", "/v1/jobs", params={"workspace_id": "interrupt"}
            )
            found = [job for job in jobs if job["command"] == command]
            if found:
                return found[-1]["job_id"]
            await asyncio.sleep(0.025)


@asynccontextmanager
async def server(host):
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    with tempfile.TemporaryDirectory(
        prefix=f"mirage-interrupt-{host}-"
    ) as directory:
        env = dict(os.environ, MIRAGE_HOME=directory)
        for name in (
            "MIRAGE_AUTH_MODE",
            "MIRAGE_AUTH_TOKEN",
            "MIRAGE_AUTH_TOKENS",
            "MIRAGE_SSH_PORT",
        ):
            env.pop(name, None)
        args = (
            [sys.executable, str(HERE / "serve.py")]
            if host == "python"
            else ["node", str(HERE / "serve.mjs")]
        )
        log_path = Path(directory) / "server.log"
        with log_path.open("w") as log:
            process = await asyncio.create_subprocess_exec(
                *args,
                str(port),
                directory + "/state",
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            try:
                async with httpx.AsyncClient(
                    base_url=f"http://127.0.0.1:{port}", timeout=2
                ) as client:
                    async with asyncio.timeout(20):
                        while True:
                            try:
                                await checked(client, "GET", "/v1/health")
                                break
                            except httpx.TransportError:
                                if process.returncode is not None:
                                    raise RuntimeError(
                                        log_path.read_text()
                                    ) from None
                                await asyncio.sleep(0.1)
                    await checked(
                        client,
                        "POST",
                        "/v1/workspaces",
                        json={
                            "id": "interrupt",
                            "config": {
                                "mounts": {
                                    "/": {"vfs": "ram", "mode": "write"}
                                }
                            },
                        },
                    )
                    await checked(
                        client,
                        "POST",
                        "/v1/workspaces/interrupt/sessions",
                        json={"session_id": "peer"},
                    )
                    yield client, port
            except BaseException:
                print(log_path.read_text()[-6000:], file=sys.stderr)
                raise
            finally:
                if process.returncode is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        await asyncio.wait_for(process.wait(), 3)
                    except TimeoutError:
                        os.killpg(process.pid, signal.SIGKILL)
                        await process.wait()
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    logging.debug("owned server process group already exited")


async def seed(client):
    rng = random.Random(7)
    files = {
        "/left": b"a\n" * 12000,
        "/rg-line": b"a" * (4 * 1024 * 1024) + b"!\n",
        "/right": b"a\n" * 11999 + b"b\n",
        "/numbers": "".join(
            f"{rng.randrange(10**18)}\n" for _ in range(300000)
        ).encode(),
    }
    for path, data in files.items():
        result = await checked(
            client,
            "POST",
            SHELL,
            files={
                "request": (
                    None,
                    json.dumps({"command": f"cat > {path}", "record": False}),
                    "application/json",
                ),
                "stdin": ("stdin.bin", data, "application/octet-stream"),
            },
            timeout=15,
        )
        assert result["exit_code"] == 0, result


async def cpu(client, case):
    job = await shell(client, case["command"], params={"background": "true"})
    # Poll during finite work too: waiting until it finishes would hide starvation.
    for _ in range(10):
        await asyncio.sleep(0.1)
        async with asyncio.timeout(0.75):
            await healthy(client)
    result = await cancel(client, job["job_id"], case["canceled"])
    if not case["canceled"]:
        assert result["status"] != "failed", result
    same = await shell(client, "echo reusable")
    assert same["stdout"] == "reusable\n", same


async def finite(client, case):
    result = await shell(client, case["command"], timeout=5)
    assert result["stdout"] == case["stdout"], result
    assert result["exit_code"] == case["exit_code"], result
    await healthy(client)


async def network(client, case):
    accepted = asyncio.Event()
    closed = asyncio.Event()
    handlers = set()

    async def upstream(reader, writer):
        task = asyncio.current_task()
        handlers.add(task)
        serving = False
        try:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n"
            )
            await writer.drain()
            serving = True
            accepted.set()
            await reader.read()
        except asyncio.IncompleteReadError:
            logging.debug("upstream pool connection closed before a request")
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(task)
            if serving:
                closed.set()

    listener = await asyncio.start_server(upstream, "127.0.0.1", 0)
    try:
        port = listener.sockets[0].getsockname()[1]
        command = case["command"].format(url=f"http://127.0.0.1:{port}/slow")
        job = await shell(client, command, params={"background": "true"})
        await asyncio.wait_for(accepted.wait(), 3)
        await cancel(client, job["job_id"])
        await asyncio.wait_for(closed.wait(), 2)
    finally:
        listener.close()
        await listener.wait_closed()
        for task in handlers:
            task.cancel()
        await asyncio.gather(*handlers, return_exceptions=True)


def multipart(command):
    return (
        b"--"
        + BOUNDARY
        + (
            b'\r\nContent-Disposition: form-data; name="request"\r\n'
            b"Content-Type: application/json\r\n\r\n"
        )
        + json.dumps({"command": command, "record": False}).encode()
        + b"\r\n--"
        + BOUNDARY
        + (
            b'\r\nContent-Disposition: form-data; name="stdin"; '
            b'filename="stdin.bin"\r\n'
            b"Content-Type: application/octet-stream\r\n\r\n"
        )
    )


@asynccontextmanager
async def raw_request(port, prefix, length, stream, multipart_body=True):
    reader, writer = await asyncio.open_connection(
        "127.0.0.1", port, limit=16384
    )
    content_type = (
        "multipart/form-data; boundary=" + BOUNDARY.decode()
        if multipart_body
        else "application/json"
    )
    path = SHELL + ("?stream=true" if stream else "")
    headers = (
        f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
        f"Content-Type: {content_type}\r\nContent-Length: {length}\r\n"
        "Connection: close\r\n\r\n"
    )
    writer.write(headers.encode() + prefix)
    await writer.drain()
    try:
        yield reader, writer
    finally:
        writer.transport.abort()
        await writer.wait_closed()


async def disconnected(client, port, stream, explicit=False):
    marker = f"/after-{stream}-{explicit}"
    command = f"sleep 1; echo leaked > {marker}"
    prefix = multipart(command) + b"x" * 1048576
    async with raw_request(port, prefix, len(prefix) + 1000000, stream) as (
        _,
        writer,
    ):
        job_id = await find_job(client, command)
        await asyncio.sleep(0.15)
        if explicit:
            await cancel(client, job_id)
        else:
            writer.transport.abort()
            await settled(client, job_id)
        await asyncio.sleep(1.1)
        result = await shell(client, f"test -e {marker}")
        assert result["exit_code"] == 1, result


async def response_body(reader):
    raw = await asyncio.wait_for(reader.read(), 3)
    headers, _, body = raw.partition(b"\r\n\r\n")
    if b"transfer-encoding: chunked" in headers.lower():
        parts = []
        while body:
            number, _, body = body.partition(b"\r\n")
            size = int(number, 16)
            if not size:
                break
            parts.append(body[:size])
            body = body[size + 2 :]
        body = b"".join(parts)
    return headers, body


async def malformed(client, port, stream):
    command = f"echo early-{stream}"
    prefix = multipart(command) + b"hello"
    async with raw_request(port, prefix, len(prefix) + 1, stream) as (
        reader,
        writer,
    ):
        job_id = await find_job(client, command)
        await settled(client, job_id, False)
        writer.write(b"Z")
        await writer.drain()
        headers, body = await response_body(reader)
        if stream:
            terminal = json.loads(body.splitlines()[-1])
            assert terminal["status"] == "failed" and terminal["error"], (
                terminal
            )
        else:
            assert b" 400 " in headers, (headers, body)


async def input_output(client, port, case):
    prefix = multipart(case["command"]) + b"x\n"
    ending = b"\r\n--" + BOUNDARY + b"--\r\n"
    async with raw_request(port, prefix, len(prefix) + len(ending), True) as (
        reader,
        writer,
    ):
        headers = await reader.readuntil(b"\r\n\r\n")
        assert b"transfer-encoding: chunked" in headers.lower(), headers
        output = b""
        while not output.endswith(b"\n"):
            length = int(await reader.readline(), 16)
            output += await reader.readexactly(length)
            assert await reader.readexactly(2) == b"\r\n"
        record = json.loads(output.splitlines()[0])
        assert record["stream"] == "stdout", record
        assert base64.b64decode(record["data"]).decode() == case["stdout"], (
            record
        )
        writer.write(ending)
        await writer.drain()
        await reader.read()
    await healthy(client)


async def oversized(client, port, stream):
    command = "sleep 60"
    prefix = multipart(command)
    size = 64 * 1024 * 1024 + 1
    async with raw_request(port, prefix, len(prefix) + size, stream) as (
        reader,
        writer,
    ):
        job_id = await find_job(client, command)
        chunk = b"x" * (256 * 1024)
        for _ in range(size // len(chunk)):
            writer.write(chunk)
            await writer.drain()
        writer.write(b"x")
        await writer.drain()
        headers, body = await response_body(reader)
        if stream:
            terminal = json.loads(body.splitlines()[-1])
            assert (
                terminal["status"] == "failed"
                and "stdin part too large" in terminal["error"]
            ), terminal
        else:
            assert b" 413 " in headers, (headers, body)
        await settled(client, job_id)
        await healthy(client)


async def unread(client, port):
    command = "seq inf"
    body = json.dumps({"command": command, "record": False}).encode()
    async with raw_request(port, body, len(body), True, False):
        job_id = await find_job(client, command)
        await asyncio.sleep(0.75)
        await cancel(client, job_id)


async def run(hosts, selected):
    cases = json.loads((HERE / "cases.json").read_text())
    for host in hosts:
        async with server(host) as (client, port):
            await seed(client)
            runs = [(case["id"], cpu, (client, case)) for case in cases["cpu"]]
            runs += [
                (case["id"], finite, (client, case))
                for case in cases["stream"]
            ]
            runs += [
                (case["id"], input_output, (client, port, case))
                for case in cases["input"]
            ]
            runs += [
                (case["id"], network, (client, case)) for case in cases["http"]
            ]
            for stream in (False, True):
                runs += [
                    (
                        f"disconnect-{stream}",
                        disconnected,
                        (client, port, stream),
                    ),
                    (
                        f"upload-cancel-{stream}",
                        disconnected,
                        (client, port, stream, True),
                    ),
                    (f"malformed-{stream}", malformed, (client, port, stream)),
                    (f"oversized-{stream}", oversized, (client, port, stream)),
                ]
            runs += [("unread-output", unread, (client, port))]
            for name, fn, args in runs:
                if selected and name not in selected:
                    continue
                start = time.monotonic()
                async with asyncio.timeout(20):
                    await fn(*args)
                print(
                    f"PASS {host} {name} ({time.monotonic() - start:.2f}s)",
                    flush=True,
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--host", action="append", choices=("python", "typescript")
    )
    parser.add_argument("--case", action="append")
    options = parser.parse_args()
    asyncio.run(run(options.host or ["python", "typescript"], options.case))
