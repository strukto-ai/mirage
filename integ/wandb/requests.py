import json
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from mirage import MountMode, Workspace
from mirage.vfs.wandb import WandbConfig, WandbVFS


async def request_checks(base: str) -> list[dict[str, Any]]:
    results = []
    scenarios = json.loads(Path(__file__).with_suffix('.json').read_text())
    for scenario in scenarios:
        vfs = WandbVFS(
            WandbConfig(entities=['lab'],
                        api_key=os.environ["WANDB_API_KEY"],
                        base_url=base))
        ws = Workspace({'/wandb': vfs}, mode=MountMode.READ)
        requests: list[dict[str, Any]] = []
        request = vfs.accessor.client.request

        async def recording(query: str,
                            variables: Mapping[str, Any]) -> dict[str, Any]:
            requests.append({'query': query, 'variables': dict(variables)})
            return await request(query, variables)

        vfs.accessor.client.request = recording
        try:
            for step in scenario['steps']:
                if step.get('invalidate'):
                    await vfs.index.invalidate()
                start = len(requests)
                result = await ws.shell(step['command'])
                results.append({
                    'exit_code': result.exit_code,
                    'requests': requests[start:]
                })
        finally:
            await ws.close()
    return results
