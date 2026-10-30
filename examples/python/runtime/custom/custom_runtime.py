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
import os
import tempfile
from pathlib import Path

from exec_server import start

from mirage import Workspace
from mirage.config import load_config

# workspace.yaml loads RemoteRuntime from remote_runtime.py beside it and
# points it at an execution service; exec_server.py stands in for the
# service on this machine. The agent only types commands: the yaml decides
# that python3 runs on the service and cat runs in the workspace.

HERE = Path(__file__).resolve().parent

REPORT = b"""import csv
rows = list(csv.DictReader(open("orders.csv")))
total = sum(int(r["total"]) for r in rows)
open("summary.txt", "w").write(f"{len(rows)} orders, total {total}\\n")
print(f"wrote summary.txt on the service: total {total}")
"""

ORDERS = b"id,item,total\n1,desk,120\n2,chair,80\n3,shelf,45\n"

LINES = [
    ("cd /work && python3 report.py", "runs on the service"),
    ("cat /work/summary.txt", "its output file is back in the mount"),
    (
        "cd /work && python3 report.py | grep -o 'total [0-9]*'",
        "its stdout pipes into workspace commands",
    ),
    ("echo 'print(6 * 7)' | python3 -", "stdin reaches the program"),
    ("cd /archive && python3 report.py", "a read-only mount refuses it"),
    ("ls /archive", "and nothing was written"),
    (
        "timeout 1 python3 -c 'import time; time.sleep(30)'",
        "a timeout stops the program on the service",
    ),
]


async def main() -> None:
    runner, url = await start()
    with tempfile.TemporaryDirectory() as archive:
        (Path(archive) / "report.py").write_bytes(REPORT)
        (Path(archive) / "orders.csv").write_bytes(ORDERS)
        os.environ["ARCHIVE_DIR"] = archive
        os.environ["EXEC_URL"] = url
        config = load_config(HERE / "workspace.yaml")
        ws = Workspace(**config.to_workspace_kwargs())
        try:
            await ws.vfs.write("/work/report.py", REPORT)
            await ws.vfs.write("/work/orders.csv", ORDERS)
            for line, note in LINES:
                res = await ws.shell(line)
                print(f"$ {line}    # {note}")
                print((res.stdout or b"").decode(), end="")
                print((res.stderr or b"").decode(), end="")
                print(f"[exit {res.exit_code}]\n")
        finally:
            await ws.close()
            await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())
