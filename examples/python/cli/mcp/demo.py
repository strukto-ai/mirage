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
import importlib.util
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import mcp_to_cli
import mcp_to_mirage
from mcp_to_cli import check_names, fetch_tools, fill

from mirage import CLI, RAMVFS, MountMode, Workspace

# Converts demo_server.py both ways, then runs the same lines through the
# real CLI (a subprocess) and the virtual CLI (inside a workspace) and
# checks they answer alike. Run from the repo root:
#
#   ./python/.venv/bin/python examples/python/cli/mcp/demo.py

HERE = Path(__file__).parent
SERVER = {
    "command": [sys.executable, "demo_server.py"],
    "cwd": str(HERE),
}
LINES = [
    'demo add-numbers \'{"a": 2, "b": 40}\'',
    'demo create-ticket \'{"title": "Fix login", "labels": ["bug"], '
    '"owner": {"name": "Ana", "email": "ana@example.com"}}\'',
    'demo delete-project \'{"project": "core"}\'',
    "demo add-numbers '[1, 2]'",
    "demo add-numbers '{\"a\": 1'",
    "demo add-numbers '{}' '{}'",
    'demo add-numbers -- \'{"a": 1, "b": 2}\'',
    "demo add-numbers -x",
    "demo add-numbers -hx",
    "demo add-numbers --verbose",
    "demo add-numbers --he",
    "demo add-numbers -1",
    "demo add-numbers -1.5",
    "demo nope",
    "demo -x",
    "demo --he",
    "demo",
    "demo --help",
    "demo create-ticket --help",
]


def load_cli(path: Path, attr: str) -> CLI:
    """Import a generated Mirage CLI module by path.

    Args:
        path (Path): the generated module.
        attr (str): the CLI it exports.
    """
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, attr)


async def main() -> None:
    tools = await fetch_tools(SERVER)
    check_names(tools)
    with tempfile.TemporaryDirectory() as out:
        real = Path(out) / "demo"
        real.write_text(fill(mcp_to_cli.TEMPLATE, "demo", SERVER, tools))
        virtual = Path(out) / "demo_cli.py"
        virtual.write_text(fill(mcp_to_mirage.TEMPLATE, "demo", SERVER, tools))
        cli = load_cli(virtual, "DEMO")
        assert not cli.handlers["add-numbers"].write
        assert cli.handlers["delete-project"].write

        ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.WRITE)
        ws.register_cli("demo", cli, {})
        try:
            for line in LINES:
                result = await ws.shell(line)
                seen = (
                    result.exit_code,
                    await result.stdout_str(),
                    await result.stderr_str(),
                )
                run = subprocess.run(
                    [sys.executable, str(real), *shlex.split(line)[1:]],
                    capture_output=True,
                    text=True,
                )
                assert seen == (run.returncode, run.stdout, run.stderr), (
                    line,
                    seen,
                    run,
                )
                print(f"$ {line}\n[exit {seen[0]}] {seen[1]}{seen[2]}")

            line = (
                'demo add-numbers \'{"a": 2, "b": 40}\' > /ram/sum.txt'
                " && cat /ram/sum.txt"
            )
            result = await ws.shell(line)
            assert await result.stdout_str() == "42\n"
            print(f"$ {line}\n42")
        finally:
            await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
