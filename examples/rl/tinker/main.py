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

import argparse
import asyncio
import os
from pathlib import Path

from config import TinkerRunConfig
from constants import (
    DEFAULT_BENCH_ROLLOUTS,
    DEFAULT_DATA_DIR,
    DEFAULT_GROUP_SIZE,
    DEFAULT_MAX_STEPS,
    DEFAULT_TINKER_MODEL,
    HERE,
)
from dotenv import load_dotenv
from runners import run_bench, run_tinker_train


def _parse_endpoints(entries: list[str]) -> dict[str, str]:
    endpoints: dict[str, str] = {}
    for entry in entries:
        if "=" not in entry:
            raise ValueError(
                f"Invalid --endpoint {entry!r}; expected service=http://..."
            )
        service, url = entry.split("=", 1)
        endpoints[service.strip()] = url.strip()
    return endpoints


def parse_config() -> TinkerRunConfig:
    """Parse CLI arguments into a validated TinkerRunConfig.

    Returns:
        TinkerRunConfig: Validated configuration for the selected mode.
    """
    load_dotenv(HERE / ".env.development")

    parser = argparse.ArgumentParser(
        description="Mirage-Harbor RL environment on Tinker."
    )
    parser.add_argument(
        "--mode",
        choices=["bench", "train"],
        default="bench",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=DEFAULT_DATA_DIR,
    )
    parser.add_argument(
        "--endpoint",
        action="append",
        default=[],
        help="Optional pre-running backend origin as service=http://host:port",
    )
    parser.add_argument("--rollouts", type=int, default=DEFAULT_BENCH_ROLLOUTS)
    parser.add_argument(
        "--model", default=os.getenv("TINKER_MODEL") or DEFAULT_TINKER_MODEL
    )
    parser.add_argument("--group-size", type=int, default=DEFAULT_GROUP_SIZE)
    parser.add_argument("--max-steps", type=int, default=DEFAULT_MAX_STEPS)
    args = parser.parse_args()
    return TinkerRunConfig(
        mode=args.mode,
        data_dir=args.data_dir,
        endpoints=_parse_endpoints(args.endpoint),
        rollouts=args.rollouts,
        model=args.model,
        group_size=args.group_size,
        max_steps=args.max_steps,
    )


async def run(config: TinkerRunConfig) -> None:
    """Dispatch the selected execution mode.

    Args:
        config (TinkerRunConfig): Validated runtime configuration.
    """
    if config.mode == "bench":
        await run_bench(config)
    elif config.mode == "train":
        await run_tinker_train(config)


if __name__ == "__main__":
    asyncio.run(run(parse_config()))
