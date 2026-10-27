import asyncio
from pathlib import Path

from utils import parse_runtime

from mirage import Workspace
from mirage.config import load_config
from mirage.policy import Route

HERE = Path(__file__).resolve().parent


async def main() -> None:
    config = load_config(HERE / "workspace.yaml")
    ws = Workspace(
        **config.to_workspace_kwargs(),
        policy_functions={"parse_runtime": parse_runtime},
    )
    try:
        for line in (
            'python3 -c "print(sum(range(1, 101)))"',
            'python3 -c "import sqlite3; print(sqlite3.sqlite_version)"',
        ):
            print(f"$ {line}")
            plan = await ws.explain(line)
            print(f"  plan: {plan.outcome.value}")
            for answer in plan.answers:
                where = (
                    f" {answer.runtime}" if isinstance(answer, Route) else ""
                )
                print(f"    {answer.kind}{where}: {answer.reason}")
                print(f"      by {answer.policy}")
            res = await ws.shell(line)
            print(f"  output: {(res.stdout or b'').decode().strip()}")
    finally:
        await ws.close()


if __name__ == "__main__":
    asyncio.run(main())
