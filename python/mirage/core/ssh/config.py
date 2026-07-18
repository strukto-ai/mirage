from pydantic import BaseModel, ConfigDict


class SSHConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    host: str
    hostname: str | None = None
    port: int | None = None
    username: str | None = None
    identity_file: str | None = None
    root: str = "/"
    timeout: int = 30
    known_hosts: str | None = None
