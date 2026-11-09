// Follows gh 2.85.0's pkg/cmd/pr/shared/editable.go and editable_http.go
// (MIT; see licenses/third_party/gh.txt).

use super::accessor::{Flags, body_value, csv_values};
use super::issue::with_special_names;
use crate::core::github::client::{Account, Result, usage};
use crate::core::github::json::{Json, Obj};
use crate::core::github::metadata::{Metadata, Wanted};
use crate::core::github::repo::mutate;

/// What `issue edit` and `pr edit` were asked to change.
pub(crate) struct Editable {
    title: Option<String>,
    body: Option<String>,
    base: Option<String>,
    pub(crate) add_labels: Vec<String>,
    pub(crate) remove_labels: Vec<String>,
    labels_edited: bool,
    add_assignees: Vec<String>,
    remove_assignees: Vec<String>,
    assignees_edited: bool,
    pub(crate) add_reviewers: Vec<String>,
    pub(crate) remove_reviewers: Vec<String>,
    pub(crate) reviewers_edited: bool,
    /// Empty clears the milestone.
    milestone: Option<String>,
}

fn given(flags: &Flags, names: [&str; 2]) -> bool {
    names.iter().any(|name| flags.raw(name).is_some())
}

impl Editable {
    pub(crate) async fn from_flags(account: &Account, flags: &Flags) -> Result<Editable> {
        let body = body_value(
            account,
            flags,
            "body",
            "body_file",
            false,
            Some("specify only one of `--body` or `--body-file`"),
        )
        .await?;
        let clear_milestone = flags.gh_bool("remove_milestone");
        if flags.raw("milestone").is_some() && clear_milestone {
            return usage("specify only one of `--milestone` or `--remove-milestone`");
        }
        let milestone = if clear_milestone {
            Some(String::new())
        } else {
            flags.as_str("milestone").map(str::to_owned)
        };
        Ok(Editable {
            title: flags.as_str("title").map(str::to_owned),
            body,
            base: flags.as_str("base").map(str::to_owned),
            add_labels: csv_values(&flags.as_list("add_label")),
            remove_labels: csv_values(&flags.as_list("remove_label")),
            labels_edited: given(flags, ["add_label", "remove_label"]),
            add_assignees: csv_values(&flags.as_list("add_assignee")),
            remove_assignees: csv_values(&flags.as_list("remove_assignee")),
            assignees_edited: given(flags, ["add_assignee", "remove_assignee"]),
            add_reviewers: csv_values(&flags.as_list("add_reviewer")),
            remove_reviewers: csv_values(&flags.as_list("remove_reviewer")),
            reviewers_edited: given(flags, ["add_reviewer", "remove_reviewer"]),
            milestone,
        })
    }

    fn dirty_excluding_labels(&self) -> bool {
        self.title.is_some()
            || self.body.is_some()
            || self.base.is_some()
            || self.reviewers_edited
            || self.assignees_edited
            || self.milestone.is_some()
    }

    pub(crate) fn dirty(&self) -> bool {
        self.labels_edited || self.dirty_excluding_labels()
    }

    pub(crate) fn wanted(&self) -> Wanted {
        Wanted {
            actor_assignees: true,
            assignees: self.assignees_edited,
            reviewers: self.reviewers_edited,
            team_reviewers: false,
            labels: self.labels_edited,
            milestones: self.milestone.is_some(),
        }
    }

    /// The fields `gh issue edit` looks each issue up with.
    pub(crate) fn lookup(&self) -> String {
        let mut fields = vec!["id,number,title,body,url"];
        if self.assignees_edited {
            fields.push(ASSIGNED_ACTORS);
        }
        if self.labels_edited {
            fields.push(LABELS);
        }
        if self.milestone.is_some() {
            fields.push(MILESTONE);
        }
        fields.join(",")
    }

    async fn assignee_ids(
        &self,
        account: &Account,
        meta: &Metadata,
        current: &Obj,
    ) -> Result<Vec<String>> {
        let mut names: Vec<String> = Vec::new();
        if !self.add_assignees.is_empty() || !self.remove_assignees.is_empty() {
            names.extend(
                current
                    .get("assignedActors")
                    .get("nodes")
                    .items()
                    .iter()
                    .map(|actor| actor.get("login").text().to_owned()),
            );
            for name in with_special_names(account, self.add_assignees.clone()).await? {
                if !names.contains(&name) {
                    names.push(name);
                }
            }
            let gone = with_special_names(account, self.remove_assignees.clone()).await?;
            names.retain(|name| !gone.contains(name));
        }
        meta.members_to_ids(&names)
    }

    /// Apply the edits to what `id` names, as gh's UpdateIssue does.
    pub(crate) async fn apply(
        &self,
        account: &Account,
        id: &str,
        is_pr: bool,
        meta: &Metadata,
        current: &Obj,
    ) -> Result<()> {
        if !self.add_labels.is_empty() {
            label_change(account, id, "LabelAdd", meta, &self.add_labels, true).await?;
        }
        if !self.remove_labels.is_empty() {
            label_change(account, id, "LabelRemove", meta, &self.remove_labels, false).await?;
        }
        if !self.dirty_excluding_labels() {
            return Ok(());
        }
        if self.assignees_edited {
            let ids = self.assignee_ids(account, meta, current).await?;
            let mut input = Obj::new();
            input.set("actorIds", ids.as_slice());
            input.set("assignableId", id);
            mutate(
                account,
                "ReplaceActorsForAssignable",
                "ReplaceActorsForAssignableInput",
                "replaceActorsForAssignable",
                "__typename",
                input,
            )
            .await?;
        }
        let mut input = Obj::new();
        input.set(if is_pr { "pullRequestId" } else { "id" }, id);
        if let Some(title) = &self.title {
            input.set("title", title.as_str());
        }
        if let Some(body) = &self.body {
            input.set("body", body.as_str());
        }
        match self.milestone.as_deref() {
            Some("") => input.set("milestoneId", Json::Null),
            Some(title) => input.set("milestoneId", meta.milestone_to_id(title)?),
            None => {}
        }
        if is_pr {
            if let Some(base) = &self.base {
                input.set("baseRefName", base.as_str());
            }
            mutate(
                account,
                "PullRequestUpdate",
                "UpdatePullRequestInput",
                "updatePullRequest",
                "__typename",
                input,
            )
            .await?;
        } else {
            mutate(
                account,
                "IssueUpdate",
                "UpdateIssueInput",
                "updateIssue",
                "__typename",
                input,
            )
            .await?;
        }
        Ok(())
    }
}

const ASSIGNED_ACTORS: &str = "assignedActors(first: 10) {nodes {...on User {id,login,name,__typename}...on Bot {id,login,__typename}},totalCount}";
const LABELS: &str = "labels(first:100){nodes{id,name,description,color},totalCount}";
const MILESTONE: &str = "milestone{number,title,description,dueOn}";

/// The fields `gh pr edit` finds its pull request with.
pub(crate) const PR_EDIT_FIELDS: &str = "id,author{login,...on User{id,name}},url,title,body,baseRefName,reviewRequests(first: 100) {nodes {requestedReviewer {__typename,...on User{login},...on Team{organization{login}name,slug}}}},labels(first:100){nodes{id,name,description,color},totalCount},milestone{number,title,description,dueOn},assignedActors(first: 10) {nodes {...on User {id,login,name,__typename}...on Bot {id,login,__typename}},totalCount},number";

async fn label_change(
    account: &Account,
    id: &str,
    operation: &str,
    meta: &Metadata,
    names: &[String],
    adding: bool,
) -> Result<()> {
    let ids = meta.labels_to_ids(names)?;
    let mut input = Obj::new();
    input.set("labelIds", ids.as_slice());
    input.set("labelableId", id);
    let (input_type, call) = if adding {
        ("AddLabelsToLabelableInput", "addLabelsToLabelable")
    } else {
        (
            "RemoveLabelsFromLabelableInput",
            "removeLabelsFromLabelable",
        )
    };
    mutate(account, operation, input_type, call, "__typename", input).await?;
    Ok(())
}
