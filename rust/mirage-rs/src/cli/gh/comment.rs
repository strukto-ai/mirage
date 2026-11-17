// Follows gh 2.85.0's pkg/cmd/issue (MIT; see licenses/third_party/gh.txt).
use super::accessor::{Flags, Out, body_value};
use crate::core::github::client::{Account, Result, usage, value};
use crate::core::github::issue::issue_comments;
use crate::core::github::json::{Json, Obj};
use crate::core::github::repo::{RepoRef, mutate};

/// The comments `--comments` asks for, None without it.
pub(crate) async fn comments_for(
    account: &Account,
    flags: &Flags,
    repo: &RepoRef,
    number: i128,
) -> Result<Option<Vec<Json>>> {
    if !flags.gh_bool("comments") {
        return Ok(None);
    }
    issue_comments(account, repo, number).await.map(Some)
}

pub(crate) fn comments_text(rows: &[Json]) -> String {
    rows.iter()
        .map(|row| {
            let status = if row.get("isMinimized").truthy() {
                row.get("minimizedReason").text().to_lowercase()
            } else {
                "none".to_owned()
            };
            format!(
                "author:\t{}\nassociation:\t{}\nedited:\t{}\nstatus:\t{status}\n--\n{}\n--\n",
                row.get("author").get("login").show(),
                row.get("authorAssociation").text().to_lowercase(),
                row.get("includesCreatedEdit").truthy(),
                row.get("body").show()
            )
        })
        .collect()
}

/// Post a comment on what `id` names, its URL back.
pub(crate) async fn add_comment(account: &Account, id: &str, body: &str) -> Result<String> {
    let mut input = Obj::new();
    input.set("body", body);
    input.set("subjectId", id);
    let data = mutate(
        account,
        "CommentCreate",
        "AddCommentInput",
        "addComment",
        "commentEdge{node{url}}",
        input,
    )
    .await?;
    Ok(data
        .get("addComment")
        .get("commentEdge")
        .get("node")
        .get("url")
        .text()
        .to_owned())
}

/// `--edit-last`, `--delete-last` and a plain new comment, for the issue
/// or pull request `id` names. `comments` are its comments, oldest first.
pub(crate) async fn comment_run(
    account: &Account,
    flags: &Flags,
    id: &str,
    comments: &[Json],
    text: &str,
) -> Result<Out> {
    let edit_last = flags.gh_bool("edit_last");
    let delete_last = flags.gh_bool("delete_last");
    let create_if_none = flags.gh_bool("create_if_none");
    let mine: Vec<&Json> = comments
        .iter()
        .filter(|row| row.get("viewerDidAuthor").truthy())
        .collect();
    if delete_last {
        let Some(last) = mine.last() else {
            return value("no comments found for current user");
        };
        let mut input = Obj::new();
        input.set("id", last.get("id").text());
        mutate(
            account,
            "CommentDelete",
            "DeleteIssueCommentInput",
            "deleteIssueComment",
            "clientMutationId",
            input,
        )
        .await?;
        return Ok(Out::warned("Comment deleted\n"));
    }
    if edit_last {
        if let Some(last) = mine.last() {
            let mut input = Obj::new();
            input.set("body", text);
            input.set("id", last.get("id").text());
            let data = mutate(
                account,
                "CommentUpdate",
                "UpdateIssueCommentInput",
                "updateIssueComment",
                "issueComment{url}",
                input,
            )
            .await?;
            return Ok(Out::text(format!(
                "{}\n",
                data.get("updateIssueComment")
                    .get("issueComment")
                    .get("url")
                    .text()
            )));
        }
        if !create_if_none {
            return value("no comments found for current user");
        }
    }
    Ok(Out::text(format!(
        "{}\n",
        add_comment(account, id, text).await?
    )))
}

/// The text of a comment, read before anything is asked of GitHub.
pub(crate) async fn comment_body(account: &Account, flags: &Flags) -> Result<String> {
    if flags.gh_bool("delete_last") {
        return Ok(String::new());
    }
    Ok(body_value(
        account,
        flags,
        "body",
        "body_file",
        true,
        Some("specify only one of `--body`, `--body-file`, `--editor`, or `--web`"),
    )
    .await?
    .unwrap_or_default())
}

/// Refuse the combinations gh's comment flags refuse.
pub(crate) fn check_comment_flags(flags: &Flags) -> Result<()> {
    let inputs =
        usize::from(flags.as_str("body").is_some()) + usize::from(flags.raw("body_file").is_some());
    if flags.gh_bool("create_if_none") && !flags.gh_bool("edit_last") {
        return usage("`--create-if-none` can only be used with `--edit-last`");
    }
    if flags.gh_bool("yes") && !flags.gh_bool("delete_last") {
        return usage("`--yes` should only be used with `--delete-last`");
    }
    if flags.gh_bool("delete_last") {
        if inputs > 0 {
            return usage("should not provide comment body when using `--delete-last`");
        }
        if !flags.gh_bool("yes") {
            return usage("should provide `--yes` to confirm deletion in non-interactive mode");
        }
        return Ok(());
    }
    if inputs == 0 {
        return usage("flags required when not running interactively");
    }
    if inputs > 1 {
        return usage("specify only one of `--body`, `--body-file`, `--editor`, or `--web`");
    }
    Ok(())
}
