from pydantic import SecretStr

from mirage.types import VFSName
from mirage.vfs.mem0 import Mem0Config
from mirage.vfs.mem0.mem0 import Mem0VFS


def test_vfs_basic():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    assert res.name == VFSName.MEM0
    assert res.caches_reads is True
    assert res.SUPPORTS_SNAPSHOT is False


def test_get_state_redacts_api_key():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    state = res.get_state()
    assert state["type"] == VFSName.MEM0
    assert "secret" not in str(state)


def test_vfs_uses_generic_read_only_surface():
    cfg = Mem0Config(api_key=SecretStr("secret"), user_id="alex")
    res = Mem0VFS(cfg)
    commands = {command.name for command in res.commands()}
    assert {"cat", "find", "grep", "jq", "ls", "rg", "search",
            "stat"} <= commands
    assert {op.name for op in res.ops_list()} == {"read", "readdir", "stat"}
