from pydantic import BaseModel, ConfigDict, SecretStr


class SSHConfig(BaseModel):
    model_config = ConfigDict(frozen=True)

    host: str
    hostname: str | None = None
    port: int | None = None
    username: str | None = None
    identity_file: str | None = None
    # Password authentication, and the passphrase of an encrypted
    # identity_file. Both are credentials, so both are SecretStr and both
    # redact out of snapshot state; without them a password-only host and
    # an encrypted key were unreachable, and a config naming either had the
    # key dropped by pydantic's extra="ignore" without a word.
    password: SecretStr | None = None
    passphrase: SecretStr | None = None
    root: str = "/"
    timeout: int = 30
    known_hosts: str | None = None
