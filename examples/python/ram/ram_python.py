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

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS


async def main() -> None:
    ws = Workspace({"/ram": RAMVFS()}, mode=MountMode.EXEC)

    print("=== python3 -c (basic) ===")
    r = await ws.shell('python3 -c "print(42)"')
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 42)")

    # The default monty runtime exposes command-line args as the `argv`
    # global; `sys.argv` exists under the `local` runtime.
    print("\n=== python3 -c with argv (flag-conditional) ===")
    r = await ws.shell('python3 -c "print(argv[1:])" alpha beta')
    print(f"argv after -c: {(await r.stdout_str()).strip()}  "
          f"(expected: ['alpha', 'beta'])")

    print("\n=== python3 /ram/script.py (abs path → dispatch read) ===")
    await ws.shell("echo 'print(\"hello from vfs\")' > /ram/h.py")
    r = await ws.shell("python3 /ram/h.py")
    print(f"stdout: {(await r.stdout_str()).strip()}  "
          f"(expected: hello from vfs)")

    print("\n=== python3 /abs/script.py arg1 arg2 (script + argv) ===")
    await ws.shell("echo 'print(argv[1:])' > /ram/argv.py")
    r = await ws.shell("python3 /ram/argv.py one two")
    print(f"argv after script: {(await r.stdout_str()).strip()}  "
          f"(expected: ['one', 'two'])")

    print("\n=== python3 bare-name script via cwd ===")
    r = await ws.shell("cd /ram && python3 h.py")
    print(f"stdout: {(await r.stdout_str()).strip()}  "
          f"(expected: hello from vfs)")

    print("\n=== echo code | python3 (stdin) ===")
    r = await ws.shell('echo "print(7*6)" | python3')
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 42)")

    print("\n=== heredoc ===")
    r = await ws.shell("python3 <<PYEOF\nprint(1 + 2)\nPYEOF")
    print(f"stdout: {(await r.stdout_str()).strip()}  (expected: 3)")

    print("\n=== session env passthrough ===")
    await ws.shell("export GREETING=hello_mirage")
    r = await ws.shell(
        "python3 -c \"import os; print(os.environ.get('GREETING','none'))\"")
    print(
        f"stdout: {(await r.stdout_str()).strip()}  (expected: hello_mirage)")

    await ws.close()


asyncio.run(main())
