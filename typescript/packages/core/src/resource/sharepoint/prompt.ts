export const SHAREPOINT_PROMPT = `{prefix}
  SharePoint document libraries backed by Microsoft Graph.
  Unscoped mounts use /{site_name}/{library_name}/{path_to_file}.
  Prefer targeted reads (grep, head) over full scans.
  File versions are retained; snapshots pin and read prior versions.`
