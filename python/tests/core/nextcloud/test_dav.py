import pytest

from mirage.core.nextcloud.dav import dav_url
from mirage.types import PathSpec

ROOT = "https://cloud.example.com/remote.php/dav/files/user"


@pytest.mark.parametrize(
    ("path", "folder", "url"),
    [
        ("/a b/c#d.txt", False, f"{ROOT}/a%20b/c%23d.txt"),
        ("/docs", True, f"{ROOT}/docs/"),
        ("/", True, f"{ROOT}/"),
    ],
)
def test_a_path_is_percent_encoded_under_the_endpoint(
    make_acc, path, folder, url
):
    assert dav_url(make_acc(), PathSpec.from_str_path(path), folder) == url
