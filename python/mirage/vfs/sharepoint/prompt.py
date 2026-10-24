PROMPT = """\
{prefix}
  SharePoint Enterprise document libraries. Multi-site, multi-drive discovery.
  Unscoped mounts use: /{site_name}/{library_name}/{path_to_file}
  Unscoped level 0 (ls /): lists all accessible SharePoint sites.
  Unscoped level 1 (ls /site/): lists document libraries (drives) in that site.
  Unscoped level 2+ (ls /site/lib/...): lists files and folders in the drive.
  IMPORTANT: This is a remote mount. Prefer targeted reads (grep, head) \
over full scans. Avoid cat on large files without piping to head/tail.
  File versions are retained, snapshots pin and read prior versions."""
