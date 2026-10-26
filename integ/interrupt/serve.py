import gc
import sys

import uvicorn

from mirage.server import build_app
from mirage.server.auth import AuthConfig, AuthMode

app = build_app(
    auth_config=AuthConfig(mode=AuthMode.LOCAL), state_root=sys.argv[2]
)
# Tuned as the daemon tunes itself (server/daemon.py), so a busy
# workspace leaves the HTTP thread the GIL as a deployed one does.
gc.collect()
gc.freeze()
gc.set_threshold(10_000, *gc.get_threshold()[1:])
sys.setswitchinterval(0.001)
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="error")
