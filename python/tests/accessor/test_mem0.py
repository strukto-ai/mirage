from pydantic import SecretStr

from mirage.accessor.mem0 import Mem0Accessor
from mirage.vfs.mem0.config import Mem0Config


def test_client_is_lazy(monkeypatch):
    built = {"n": 0}

    class FakeClient:

        def __init__(self, **kwargs):
            built["n"] += 1
            self.kwargs = kwargs

    monkeypatch.setattr("mirage.accessor.mem0.AsyncMemoryClient", FakeClient)
    cfg = Mem0Config(api_key=SecretStr("secret-key"), user_id="alex")
    accessor = Mem0Accessor(cfg)
    assert built["n"] == 0
    client = accessor.client
    assert built["n"] == 1
    assert client.kwargs["api_key"] == "secret-key"
    assert client.kwargs["host"] == "https://api.mem0.ai"
    assert accessor.client is client
    assert built["n"] == 1
