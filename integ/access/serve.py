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
"""The deployed Python server: ``build_app()`` under uvicorn.

Every setting comes from the environment, as in a deployment: auth from
``MIRAGE_AUTH_MODE`` and its keys, SSH from ``MIRAGE_SSH_*``, and the
snapshot store an operator passes ``build_app`` from
``ACCESS_SNAPSHOT_STORE`` (an ``S3Config`` as JSON). When
``ACCESS_LOOP_LAG`` names a file, the server's loop is timed for the
length of the run and the summary written there as it stops. Run as
``python integ/access/serve.py PORT``.
"""

import json
import os
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from loop_lag import LOOP_LAG_ENV, LoopLag

from mirage.server.app import build_app
from mirage.vfs.s3.config import S3Config

store = os.environ.get("ACCESS_SNAPSHOT_STORE")
lag_file = os.environ.get(LOOP_LAG_ENV)
app = build_app(
    snapshot_store=S3Config(**json.loads(store)) if store else None
)
_serve = app.router.lifespan_context


@asynccontextmanager
async def _timed(served: FastAPI) -> AsyncIterator[None]:
    """The app's lifespan with its loop timed, written out as it stops.

    Args:
        served (FastAPI): the server app.
    """
    async with _serve(served):
        lag = LoopLag()
        lag.start()
        try:
            yield
        finally:
            Path(lag_file).write_text(json.dumps(lag.stop()))


if lag_file:
    app.router.lifespan_context = _timed
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
