from typing import Literal

from mirage.io.pipe import CAPACITY
from mirage.types import FileType

HOME = "/home/user"
ENVD_PORT = "49983"

CONNECT_STREAM = "application/connect+json"
DEADLINE_MESSAGE = "command deadline exceeded"
PROCESS_PREFIX = "/process.Process/"
START = PROCESS_PREFIX + "Start"
CONTROL_METHODS = ("List", "SendInput", "CloseStdin", "SendSignal")
MAX_CONTROL_BODY = 2 * CAPACITY

CREATE = "/v2/sandboxes"
CONNECT = "/v2/sandboxes/{sandbox_id}/connect"
KILL = "/sandboxes/{sandbox_id}"
SET_TIMEOUT = "/sandboxes/{sandbox_id}/timeout"
HEALTH = "/health"
BASE_TEMPLATE = "base"
DEFAULT_TIMEOUT = 300
ENVD_VERSION = "0.5.6"
FILES = "/files"
RPC_PREFIX = "/filesystem.Filesystem/"
FileMethod = Literal["Stat", "ListDir", "MakeDir", "Move", "Remove"]
METHODS: tuple[FileMethod, ...] = (
    "Stat",
    "ListDir",
    "MakeDir",
    "Move",
    "Remove",
)
UNSUPPORTED_LIFECYCLE_ROUTES = (
    ("GET", CREATE),
    ("GET", "/sandboxes"),
    ("GET", KILL),
    ("GET", "/sandboxes/{sandbox_id}/metrics"),
    ("POST", "/sandboxes/{sandbox_id}/pause"),
    ("POST", "/sandboxes/{sandbox_id}/resume"),
)
UNSUPPORTED_RPC_PATHS = (
    RPC_PREFIX + "WatchDir",
    RPC_PREFIX + "CreateWatcher",
    RPC_PREFIX + "GetWatcherEvents",
    RPC_PREFIX + "RemoveWatcher",
    PROCESS_PREFIX + "Connect",
    PROCESS_PREFIX + "Update",
    PROCESS_PREFIX + "StreamInput",
)
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

TYPES = {
    FileType.FILE: "FILE_TYPE_FILE",
    FileType.DIRECTORY: "FILE_TYPE_DIRECTORY",
    FileType.SYMLINK: "FILE_TYPE_SYMLINK",
}
