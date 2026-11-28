from tests.fixtures.aioresponses_patch import patch_aioresponses
from tests.fixtures.google_account import google_account
from tests.fixtures.graph_drive import onedrive, sharepoint

__all__ = ["google_account", "onedrive", "sharepoint"]

patch_aioresponses()
