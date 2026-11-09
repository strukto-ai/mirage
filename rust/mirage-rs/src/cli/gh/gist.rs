// Follows gh 2.85.0's pkg/cmd/gist (MIT; see licenses/third_party/gh.txt).

use std::collections::BTreeMap;

use super::accessor::{Flags, Out, one_line, read_cli_file, time_field, tsv};
use super::args::wrong_count;
use crate::core::github::client::{Account, Failure, Result, github_request, usage, value};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::repo::{current_login, graphql_data, urlsplit};
use crate::request::Request;

const ZERO_TIME: &str = "0001-01-01T00:00:00Z";

const GIST_LIST: &str = "query GistList($endCursor:String$includeContent:Boolean!$per_page:Int!$visibility:GistPrivacy!){viewer{gists(first: $per_page, after: $endCursor, privacy: $visibility, orderBy: {field: CREATED_AT, direction: DESC}){nodes{description,files{name,text @include(if: $includeContent)},isPublic,name,updatedAt},pageInfo{hasNextPage,endCursor}}}}";

/// The id a gist selector names: itself, or the second part of a URL's path.
fn gist_id(selector: &str) -> Result<String> {
    if !selector.contains('/') {
        return Ok(selector.to_owned());
    }
    let parts: Vec<String> = urlsplit(selector)
        .map(|url| url.path.split('/').map(str::to_owned).collect())
        .unwrap_or_default();
    if parts.first().is_some_and(String::is_empty) {
        if parts.len() > 2 {
            return Ok(parts[2].clone());
        }
        if parts.len() == 2 && !parts[1].is_empty() {
            return Ok(parts[1].clone());
        }
    }
    value(format!("Invalid gist URL {selector}"))
}

async fn get_gist(account: &Account, id: &str) -> Result<Option<Json>> {
    match github_request(account, "GET", &format!("/gists/{id}"), None).await {
        Err(Failure::Api(error)) if error.status == 404 => Ok(None),
        Err(failure) => Err(failure),
        Ok(gist) => Ok(Some(gist)),
    }
}

/// Which of `texts` the POSIX pattern matches, by the host's regex engine.
async fn matches_filter(account: &Account, pattern: &str, texts: &[String]) -> Result<Vec<bool>> {
    let mut doc = Obj::new();
    doc.set("pattern", pattern);
    doc.set("texts", texts);
    let (reply, outputs) = account
        .host
        .ask(Request::Jq {
            program: ".pattern as $p | .texts | map(test($p))".to_owned(),
            doc: Json::Obj(doc).dump().into_bytes(),
        })
        .await;
    if let Some(error) = reply.error {
        return value(error);
    }
    let parsed = Json::parse(&outputs).map_err(Failure::Value)?;
    Ok(parsed.items().iter().map(Json::truthy).collect())
}

struct Listed {
    id: String,
    description: String,
    public: bool,
    updated: Json,
    files: Vec<(String, String)>,
}

pub(crate) async fn list_cmd(account: &Account, flags: &Flags) -> Result<Out> {
    let limit = flags.as_int("limit").unwrap_or(10);
    if limit < 1 {
        return usage(format!("invalid limit: {limit}"));
    }
    let filter = flags.as_nonempty("filter");
    let include = flags.gh_bool("include_content");
    if filter.is_none() && include {
        return usage("cannot use --include-content without --filter");
    }
    let visibility = if flags.gh_bool("secret") {
        "SECRET"
    } else if flags.gh_bool("public") {
        "PUBLIC"
    } else {
        "ALL"
    };
    let mut found: Vec<Listed> = Vec::new();
    let mut cursor = Json::Null;
    'pages: loop {
        let mut variables = Obj::new();
        variables.set("endCursor", cursor.clone());
        variables.set("includeContent", include);
        variables.set("per_page", limit.min(100));
        variables.set("visibility", visibility);
        let data = graphql_data(account, GIST_LIST, variables).await?;
        let page = data.get("viewer").get("gists");
        for node in page.get("nodes").items() {
            let gist = Listed {
                id: node.get("name").text().to_owned(),
                description: node.get("description").text().to_owned(),
                public: node.get("isPublic").truthy(),
                updated: node.get("updatedAt").clone(),
                files: node
                    .get("files")
                    .items()
                    .iter()
                    .map(|file| {
                        (
                            file.get("name").text().to_owned(),
                            file.get("text").text().to_owned(),
                        )
                    })
                    .collect(),
            };
            if let Some(pattern) = filter {
                let mut texts = vec![gist.description.clone()];
                texts.extend(gist.files.iter().map(|file| file.0.clone()));
                if include {
                    texts.extend(gist.files.iter().map(|file| file.1.clone()));
                }
                if !matches_filter(account, pattern, &texts)
                    .await?
                    .contains(&true)
                {
                    continue;
                }
            }
            found.push(gist);
            if found.len() as i64 == limit {
                break 'pages;
            }
        }
        if page.get("nodes").items().is_empty() || !page.get("pageInfo").get("hasNextPage").truthy()
        {
            break;
        }
        cursor = page.get("pageInfo").get("endCursor").clone();
    }
    if let (Some(pattern), true) = (filter, include) {
        let mut out = String::new();
        for gist in &found {
            for (name, content) in &gist.files {
                let mut matched =
                    matches_filter(account, pattern, std::slice::from_ref(name)).await?[0];
                let mut block = format!("{} {name}\n", gist.id);
                if !gist.description.is_empty() {
                    matched |=
                        matches_filter(account, pattern, std::slice::from_ref(&gist.description))
                            .await?[0];
                    block.push_str(&format!("    {}\n", gist.description));
                }
                let lines: Vec<String> = content
                    .split(['\n', '\r'])
                    .filter(|line| !line.is_empty())
                    .map(str::to_owned)
                    .collect();
                for (line, hit) in lines
                    .iter()
                    .zip(matches_filter(account, pattern, &lines).await?)
                {
                    if hit {
                        matched = true;
                        block.push_str(&format!("        {line}\n"));
                    }
                }
                if matched {
                    out.push_str(&block);
                    out.push('\n');
                }
            }
        }
        return Ok(Out::text(out));
    }
    Ok(Out::text(
        found
            .iter()
            .map(|gist| {
                let description = if gist.description.is_empty() {
                    gist.files
                        .iter()
                        .map(|file| file.0.as_str())
                        .find(|name| !name.starts_with("gistfile"))
                        .unwrap_or("")
                        .to_owned()
                } else {
                    gist.description.clone()
                };
                let count = gist.files.len();
                tsv(&[
                    gist.id.clone(),
                    one_line(&description),
                    format!("{count} file{}", if count == 1 { "" } else { "s" }),
                    if gist.public { "public" } else { "secret" }.to_owned(),
                    time_field(&gist.updated),
                ])
            })
            .collect::<String>(),
    ))
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
}

fn render(file: &Json, content: &str, out: &mut String) {
    let _ = file;
    out.push_str(content);
    if !content.ends_with('\n') {
        out.push('\n');
    }
}

pub(crate) async fn view_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let Some(selector) = texts.first() else {
        return usage("gist ID or URL required when not running interactively");
    };
    let id = gist_id(selector)?;
    let Some(gist) = get_gist(account, &id).await? else {
        return value("not found");
    };
    let files = gist.get("files");
    let mut names: Vec<String> = files
        .as_obj()
        .map(|obj| obj.iter().map(|(name, _)| name.clone()).collect())
        .unwrap_or_default();
    let content_of = |name: &str| files.get(name).get("content").text().to_owned();
    if let Some(name) = flags.as_nonempty("filename") {
        if files.as_obj().is_none_or(|obj| !obj.has(name)) {
            return value(format!("gist has no such file: {}", quoted(name)));
        }
        let content = content_of(name);
        if is_binary(content.as_bytes()) {
            return value("error: file is binary");
        }
        let mut out = String::new();
        render(files.get(name), &content, &mut out);
        return Ok(Out::text(out));
    }
    let listing = flags.gh_bool("files");
    let mut out = String::new();
    let description = gist.get("description").text();
    if !description.is_empty() && !listing {
        out.push_str(&format!("{description}\n\n"));
    }
    names.sort_by_key(|name| name.to_lowercase());
    if listing {
        for name in &names {
            out.push_str(name);
            out.push('\n');
        }
        return Ok(Out::text(out));
    }
    let many = names.len() > 1;
    for (at, name) in names.iter().enumerate() {
        if many {
            out.push_str(&format!("{name}\n\n"));
        }
        let content = content_of(name);
        if is_binary(content.as_bytes()) {
            if names.len() == 1 {
                return value("error: file is binary");
            }
            out.push_str("(skipping rendering binary content)\n");
        } else {
            render(files.get(name), &content, &mut out);
        }
        if at + 1 < names.len() {
            out.push('\n');
        }
    }
    Ok(Out::text(out))
}

fn base_name(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

fn is_default_name(name: &str) -> bool {
    name.strip_prefix("gistfile")
        .and_then(|tail| tail.strip_suffix(".txt"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) async fn create_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let (stdin_args, mut names): (Vec<&String>, Vec<&String>) =
        texts.iter().partition(|name| *name == "-");
    names.extend(stdin_args);
    let dash = "-".to_owned();
    if names.is_empty() {
        names.push(&dash);
    }
    let mut files: BTreeMap<String, String> = BTreeMap::new();
    for (at, name) in names.iter().enumerate() {
        let (filename, content) = if *name == "-" {
            let bytes = read_cli_file(account, None, Some("-"), "gist")
                .await
                .map_err(|failure| {
                    Failure::Value(format!(
                        "failed to collect files for posting: failed to read from stdin: {}",
                        failure.text()
                    ))
                })?;
            if is_binary(&bytes) {
                return value(
                    "failed to collect files for posting: binary file contents not supported",
                );
            }
            let filename = flags
                .as_nonempty("filename")
                .map_or_else(|| format!("gistfile{at}.txt"), str::to_owned);
            (filename, bytes)
        } else {
            let bytes = read_cli_file(account, None, Some(name), "gist")
                .await
                .map_err(|failure| {
                    if failure.text().ends_with("no such file or directory") {
                        return Failure::Value(format!("no matches found for `{name}`"));
                    }
                    Failure::Value(format!(
                        "failed to collect files for posting: failed to read file {name}: {}",
                        failure.text()
                    ))
                })?;
            if is_binary(&bytes) {
                return value(format!(
                    "failed to collect files for posting: failed to upload {name}: binary file not supported"
                ));
            }
            (base_name(name), bytes)
        };
        files.insert(filename, String::from_utf8_lossy(&content).into_owned());
    }
    let named: Vec<&String> = files.keys().filter(|name| !is_default_name(name)).collect();
    let gist_name = named.first().map_or("", |name| name.as_str()).to_owned();
    let progress = if gist_name.is_empty() {
        "Creating gist...".to_owned()
    } else if files.len() > 1 {
        "Creating gist with multiple files".to_owned()
    } else {
        format!("Creating gist {gist_name}")
    };
    let public = flags.gh_bool("public");
    let mut payload = Obj::new();
    payload.set("description", flags.as_str("desc").unwrap_or(""));
    payload.set("public", public);
    payload.set("updated_at", ZERO_TIME);
    let mut listing = Obj::new();
    for (name, content) in &files {
        let mut file = Obj::new();
        file.set("content", content.as_str());
        listing.set(name.as_str(), file);
    }
    payload.set("files", listing);
    let created = match github_request(account, "POST", "/gists", Some(&Json::Obj(payload))).await {
        Ok(created) => created,
        Err(Failure::Api(error))
            if error.status == 422 && files.values().any(|content| content.trim().is_empty()) =>
        {
            return Ok(Out::failed(format!(
                "- {progress}\nX Failed to create gist: a gist file cannot be blank\n"
            )));
        }
        Err(failure) => {
            return value(format!(
                "- {progress}\nX Failed to create gist: {}",
                failure.text()
            ));
        }
    };
    let mut done = format!("Created {} gist", if public { "public" } else { "secret" });
    if !gist_name.is_empty() {
        done.push(' ');
        done.push_str(&gist_name);
    }
    Ok(Out {
        stdout: format!("{}\n", created.get("html_url").text()).into_bytes(),
        stderr: format!("- {progress}\n✓ {done}\n").into_bytes(),
        exit: 0,
    })
}

async fn owned(account: &Account, id: &str) -> Result<Json> {
    let Some(gist) = get_gist(account, id).await? else {
        return value(format!("gist not found: {id}"));
    };
    if current_login(account).await? != gist.get("owner").get("login").text() {
        return value("you do not own this gist");
    }
    Ok(gist)
}

async fn update(account: &Account, id: &str, description: &str, files: Obj) -> Result<Out> {
    let mut payload = Obj::new();
    payload.set("description", description);
    payload.set("files", files);
    github_request(
        account,
        "POST",
        &format!("/gists/{id}"),
        Some(&Json::Obj(payload)),
    )
    .await?;
    Ok(Out::default())
}

pub(crate) async fn edit_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    if texts.len() > 2 {
        return usage("too many arguments");
    }
    let Some(selector) = texts.first() else {
        return usage("gist ID or URL required when not running interactively");
    };
    let add = flags.as_nonempty("add");
    let remove = flags.as_nonempty("remove");
    let edit = flags.as_nonempty("filename");
    if add.is_some() && remove.is_some() {
        return value(
            "if any flags in the group [add remove] are set none of the others can be; [add remove] were all set",
        );
    }
    if remove.is_some() && edit.is_some() {
        return value(
            "if any flags in the group [remove filename] are set none of the others can be; [filename remove] were all set",
        );
    }
    let source = texts.get(1).map(String::as_str);
    let id = gist_id(selector)?;
    let gist = owned(account, &id).await?;
    let mut description = gist.get("description").text().to_owned();
    let new_description = flags.as_nonempty("desc");
    if let Some(given) = new_description {
        description = given.to_owned();
    }
    let files = gist.get("files");
    if let Some(name) = add {
        let bytes = read_cli_file(account, None, Some(source.unwrap_or(name)), "--add").await?;
        if is_binary(&bytes) {
            return value(format!(
                "failed to upload {name}: binary file not supported"
            ));
        }
        if bytes.is_empty() {
            return value("file contents cannot be empty");
        }
        let filename = base_name(name);
        let mut file = Obj::new();
        file.set("content", String::from_utf8_lossy(&bytes).into_owned());
        file.set("filename", filename.as_str());
        let mut listing = Obj::new();
        listing.set(filename, file);
        return update(account, &id, &description, listing).await;
    }
    if let Some(name) = remove {
        if files.as_obj().is_none_or(|obj| !obj.has(name)) {
            return value(format!("gist has no file {}", quoted(name)));
        }
        let mut listing = Obj::new();
        listing.set(name, Json::Null);
        return update(account, &id, &description, listing).await;
    }
    let mut names: Vec<String> = files
        .as_obj()
        .map(|obj| obj.iter().map(|(name, _)| name.clone()).collect())
        .unwrap_or_default();
    names.sort();
    let target = match (edit, names.as_slice()) {
        (Some(name), _) => name.to_owned(),
        (None, [only]) => only.clone(),
        (None, []) => return value("no file in the gist"),
        (None, _) => {
            if source.is_none() && new_description.is_some() {
                return update(account, &id, &description, Obj::new()).await;
            }
            return value(
                "unsure what file to edit; either specify --filename or run interactively",
            );
        }
    };
    if files.as_obj().is_none_or(|obj| !obj.has(&target)) {
        return value(format!("gist has no file {}", quoted(&target)));
    }
    let current = files.get(&target).get("content").text().to_owned();
    if is_binary(current.as_bytes()) {
        return value("editing binary files not supported");
    }
    let Some(source) = source else {
        if new_description.is_some() {
            return update(account, &id, &description, Obj::new()).await;
        }
        return value("unsure what to edit: pass a file with the new content");
    };
    let bytes = read_cli_file(account, None, Some(source), "gist edit").await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    let mut listing = Obj::new();
    if text != current {
        let mut file = Obj::new();
        file.set("content", text);
        file.set("filename", target.as_str());
        listing.set(target, file);
    } else if new_description.is_none() {
        return Ok(Out::default());
    }
    update(account, &id, &description, listing).await
}

pub(crate) async fn delete_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    if !flags.gh_bool("yes") {
        return usage("--yes required when not running interactively");
    }
    let Some(selector) = texts.first() else {
        return usage("id or url argument required in non-interactive mode");
    };
    let id = gist_id(selector)?;
    let Some(gist) = get_gist(account, &id).await? else {
        return value("not found");
    };
    let id = gist.get("id").text();
    match github_request(account, "DELETE", &format!("/gists/{id}"), None).await {
        Err(Failure::Api(error)) if error.status == 404 => {
            let first = gist
                .get("files")
                .as_obj()
                .and_then(|files| files.iter().map(|(name, _)| name).min());
            value(format!(
                "unable to delete gist {}: either the gist is not found or it is not owned by you",
                quoted(first.map_or("", String::as_str))
            ))
        }
        Err(failure) => Err(failure),
        Ok(_) => Ok(Out::default()),
    }
}

pub(crate) async fn rename_cmd(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let _ = flags;
    let [selector, old_name, new_name] = texts else {
        return wrong_count(3, texts);
    };
    let id = gist_id(selector)?;
    let gist = owned(account, &id).await?;
    let files = gist.get("files");
    let has = |name: &str| files.as_obj().is_some_and(|obj| obj.has(name));
    if !has(old_name) {
        return value(format!("File {old_name} not found in gist"));
    }
    if has(new_name) {
        return value(format!("File {new_name} already exists in gist"));
    }
    let mut listing = Obj::new();
    for (name, file) in files.as_obj().into_iter().flat_map(Obj::iter) {
        listing.set(name.as_str(), sent_file(file, name));
    }
    listing.set(new_name.as_str(), sent_file(files.get(old_name), new_name));
    let mut blank = Obj::new();
    blank.set("content", "");
    listing.set(old_name.as_str(), blank);
    let mut payload = Obj::new();
    payload.set("description", gist.get("description").text());
    payload.set("files", listing);
    payload.set("public", false);
    payload.set("updated_at", ZERO_TIME);
    github_request(
        account,
        "POST",
        &format!("/gists/{}", gist.get("id").text()),
        Some(&Json::Obj(payload)),
    )
    .await?;
    Ok(Out::default())
}

/// A file of a gist as gh's GistFile marshals it, under `name`.
fn sent_file(file: &Json, name: &str) -> Obj {
    let mut sent = Obj::new();
    sent.set("content", file.get("content").clone());
    sent.set("filename", name);
    for key in ["language", "type"] {
        if let Some(text) = file.get(key).as_str().filter(|text| !text.is_empty()) {
            sent.set(key, text);
        }
    }
    sent
}
