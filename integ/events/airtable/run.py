import asyncio
import json
import os
from pathlib import Path

import aiohttp

from mirage import Workspace
from mirage.types import PathSpec
from mirage.vfs.airtable import AirtableConfig, AirtableVFS

SPECIFICATION = {"options": {"filters": {"dataTypes": ["tableData"]}}}


async def run_case(origin: str, spec: dict, case: dict) -> None:
    """Args:
    origin (str): The Airtable fake's origin.
    spec (dict): Parsed case file.
    case (dict): The writes between two pings, and the changes expected,
        each at a path the mount serves.
    """
    run = f"events-python-{case['id']}"
    base_url = f"{origin}/_run/{run}/v0"
    headers = {"Authorization": f"Bearer {spec['token']}"}
    relative = case["root"]
    virtual = spec["mount"] + ("/" + relative if relative else "")
    root = PathSpec.from_str_path(virtual, vfs_path=relative)
    vfs = AirtableVFS(
        AirtableConfig(
            token=spec["token"], base_url=base_url, requests_per_second=100
        )
    )
    ws = Workspace({spec["mount"]: vfs})
    hook = vfs.delta_hook()
    async with aiohttp.ClientSession(headers=headers) as http:
        try:
            async with http.post(f"{origin}/_run/{run}/reset", json={}) as r:
                r.raise_for_status()
            async with http.post(
                f"{base_url}/bases/{spec['base']}/webhooks",
                json={"specification": SPECIFICATION},
            ) as r:
                r.raise_for_status()
            baseline = await hook.pull(root, None)
            assert baseline.changes == (), baseline.changes
            for write in case["writes"]:
                async with http.request(
                    write["method"],
                    f"{base_url}/{write['path']}",
                    json=write.get("body"),
                ) as r:
                    r.raise_for_status()
            delta = await hook.pull(root, baseline.checkpoint)
            got = [[c.kind.value, c.path.virtual] for c in delta.changes]
            assert got == case["expect"], (case["id"], got)
            for kind, path in got:
                if kind != "delete":
                    served = await ws.shell(f"ls -d {path}")
                    assert served.exit_code == 0, (case["id"], path)
            again = await hook.pull(root, delta.checkpoint)
            assert again.changes == (), (case["id"], again.changes)
            print(f"PASS python airtable {case['id']}")
        finally:
            await ws.close()


async def main() -> None:
    origin = os.environ.get("AIRTABLE_URL")
    if not origin:
        print("SKIP python airtable: AIRTABLE_URL is unset")
        return
    spec = json.loads(Path(__file__).with_name("cases.json").read_text())
    for case in spec["cases"]:
        await run_case(origin.rstrip("/"), spec, case)


if __name__ == "__main__":
    asyncio.run(main())
