import opendal

from mirage.accessor.base import Accessor
from mirage.resource.secrets import reveal_secret


class NextcloudAccessor(Accessor):

    def __init__(self, config) -> None:
        self.config = config

    def operator(self):
        config = self.config
        kwargs = {"endpoint": config.url}
        username = reveal_secret(config.username)
        if username:
            kwargs["username"] = username
        password = reveal_secret(config.password)
        if password:
            kwargs["password"] = password
        return opendal.AsyncOperator("webdav", **kwargs)
