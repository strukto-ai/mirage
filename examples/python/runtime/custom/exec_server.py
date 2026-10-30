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

import asyncio
import base64
import tempfile
from pathlib import Path

from aiohttp import web

# A stand-in for the execution service, so the example runs on one machine.
# POST /run takes {argv, stdin, files} with base64 bytes, runs argv in a
# fresh directory holding those files, and answers {stdout, stderr,
# exit_code, files} with the files the program created or changed. A
# dropped connection kills the program.


async def run(request: web.Request) -> web.Response:
    """Run one program in a scratch directory.

    Args:
        request (web.Request): the run request.
    """
    body = await request.json()
    sent = {rel: base64.b64decode(b) for rel, b in body["files"].items()}
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        for rel, data in sent.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_bytes(data)
        try:
            proc = await asyncio.create_subprocess_exec(
                *body["argv"],
                cwd=root,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            return _answer(
                b"", f"{body['argv'][0]}: not found\n".encode(), 127
            )
        try:
            out, err = await proc.communicate(base64.b64decode(body["stdin"]))
        except asyncio.CancelledError:
            proc.kill()
            await proc.wait()
            raise
        changed = {
            str(p.relative_to(root)): p.read_bytes()
            for p in root.rglob("*")
            if p.is_file()
            and sent.get(str(p.relative_to(root))) != p.read_bytes()
        }
    return _answer(out, err, proc.returncode or 0, changed)


def _answer(
    out: bytes, err: bytes, code: int, files: dict[str, bytes] | None = None
) -> web.Response:
    return web.json_response(
        {
            "stdout": base64.b64encode(out).decode(),
            "stderr": base64.b64encode(err).decode(),
            "exit_code": code,
            "files": {
                rel: base64.b64encode(data).decode()
                for rel, data in (files or {}).items()
            },
        }
    )


async def start() -> tuple[web.AppRunner, str]:
    """Serve on a free localhost port; returns the runner and run URL."""
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app.router.add_post("/run", run)
    runner = web.AppRunner(app, handler_cancellation=True)
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 0).start()
    port = runner.addresses[0][1]
    return runner, f"http://127.0.0.1:{port}/run"
