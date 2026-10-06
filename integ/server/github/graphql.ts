// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { buildSchema, graphql } from 'graphql'

import type { Ctx, JsonValue, KitRoute, Reply } from '../kit/typescript/index.ts'
import { DEFAULT_LOGIN } from './config.ts'
import type { C } from './config.ts'
import { authedRoute, everywhere, jsonBodyOf, route, str } from './http.ts'
import { ownedRepositories, repositoryNode } from './repos.ts'
import { repoByName } from './store.ts'

// The slice of the vendor's schema the clients here send: issue and pull
// request comments, every Repository, PullRequest and Issue field that
// `gh repo`, `gh pr` and `gh issue` `view/list --json` select, with the
// argument and enum spellings gh 2.85 puts on the wire, and a ref's commit
// history (`ref`, `Ref.target`, `Commit.history`), which a `gh api graphql`
// query reads and which lists what `GET /commits` lists.
//
// One departure: the vendor types an issue's `state` and a pull request's as
// two enums, yet answers gh's IssueByNumber, which reads `state` through
// both `...on Issue` and `...on PullRequest` at once. graphql-js refuses that
// selection for two different enums, so both are strings here, which
// answers the same values.
const SCHEMA = buildSchema(`
  type Query {
    repository(owner: String!, name: String!): Repository
    repositoryOwner(login: String!): RepositoryOwner
    viewer: User!
  }
  enum IssueState { OPEN CLOSED }
  enum IssueStateReason { REOPENED NOT_PLANNED COMPLETED DUPLICATE }
  input IssueFilters {
    assignee: String, createdBy: String, mentioned: String, labels: [String!]
  }
  enum PullRequestState { OPEN CLOSED MERGED }
  enum MilestoneState { OPEN CLOSED }
  enum ProjectState { OPEN CLOSED }
  enum RepositoryPrivacy { PUBLIC PRIVATE }
  enum RepositoryAffiliation { OWNER COLLABORATOR ORGANIZATION_MEMBER }
  enum RepositoryOrderField { CREATED_AT UPDATED_AT PUSHED_AT NAME STARGAZERS }
  enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
  enum OrderDirection { ASC DESC }
  enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
  enum MergeStateStatus { BEHIND BLOCKED CLEAN DIRTY DRAFT HAS_HOOKS UNKNOWN UNSTABLE }
  enum PullRequestReviewDecision { CHANGES_REQUESTED APPROVED REVIEW_REQUIRED }
  enum PullRequestReviewState { PENDING COMMENTED APPROVED CHANGES_REQUESTED DISMISSED }
  input RepositoryOrder { field: RepositoryOrderField!, direction: OrderDirection! }
  input IssueOrder { field: IssueOrderField!, direction: OrderDirection! }
  interface Actor { login: String! }
  interface RepositoryOwner {
    id: ID!
    login: String!
    repositories(first: Int!, after: String, privacy: RepositoryPrivacy, isFork: Boolean,
      ownerAffiliations: [RepositoryAffiliation], orderBy: RepositoryOrder): RepositoryConnection!
  }
  type User implements Actor & RepositoryOwner {
    id: ID!
    login: String!
    name: String
    databaseId: Int
    repositories(first: Int!, after: String, privacy: RepositoryPrivacy, isFork: Boolean,
      ownerAffiliations: [RepositoryAffiliation], orderBy: RepositoryOrder): RepositoryConnection!
  }
  type Organization implements Actor & RepositoryOwner {
    id: ID!
    login: String!
    name: String
    repositories(first: Int!, after: String, privacy: RepositoryPrivacy, isFork: Boolean,
      ownerAffiliations: [RepositoryAffiliation], orderBy: RepositoryOrder): RepositoryConnection!
  }
  type Bot implements Actor { id: ID!, login: String! }
  type RepositoryConnection { nodes: [Repository!]!, totalCount: Int!, pageInfo: PageInfo! }
  type Owner { id: ID!, login: String! }
  type Count { totalCount: Int! }
  scalar GitTimestamp
  interface GitObject { oid: String! }
  type Ref { name: String!, prefix: String!, target: GitObject }
  type Tag implements GitObject { oid: String!, name: String!, message: String, target: GitObject! }
  type Tree implements GitObject { oid: String! }
  type Blob implements GitObject { oid: String! }
  type CodeOfConduct { key: String!, name: String!, url: String }
  type ContactLink { about: String!, name: String!, url: String! }
  type FundingLink { platform: String!, url: String! }
  type License { key: String!, name: String!, nickname: String }
  type Topic { name: String! }
  type TopicNode { topic: Topic! }
  type TopicConnection { nodes: [TopicNode!]! }
  type Language { name: String! }
  type LanguageEdge { size: Int!, node: Language! }
  type LanguageConnection { edges: [LanguageEdge!]! }
  type IssueTemplate { name: String!, title: String, body: String, about: String }
  type PullRequestTemplate { body: String, filename: String }
  type Label { id: ID!, color: String!, name: String!, description: String }
  type LabelConnection { nodes: [Label!]!, totalCount: Int! }
  type Milestone { number: Int!, title: String!, description: String, dueOn: String }
  type MilestoneConnection { nodes: [Milestone!]! }
  type Release { publishedAt: String, tagName: String!, name: String, url: String! }
  type UserConnection { nodes: [User!]!, totalCount: Int! }
  type Project { id: ID!, name: String!, number: Int!, body: String, resourcePath: String! }
  type ProjectConnection { nodes: [Project!]! }
  type ProjectV2 { id: ID!, number: Int!, title: String!, resourcePath: String!,
    closed: Boolean!, url: String! }
  type ProjectV2Connection { nodes: [ProjectV2!]! }
  type Repository {
    id: ID!
    name: String!
    nameWithOwner: String!
    owner: Owner!
    parent: Repository
    templateRepository: Repository
    description: String
    homepageUrl: String
    openGraphImageUrl: String!
    usesCustomOpenGraphImage: Boolean!
    url: String!
    sshUrl: String!
    mirrorUrl: String
    securityPolicyUrl: String
    createdAt: String!
    pushedAt: String
    updatedAt: String!
    archivedAt: String
    isBlankIssuesEnabled: Boolean!
    isSecurityPolicyEnabled: Boolean
    hasIssuesEnabled: Boolean!
    hasProjectsEnabled: Boolean!
    hasDiscussionsEnabled: Boolean!
    hasWikiEnabled: Boolean!
    mergeCommitAllowed: Boolean!
    squashMergeAllowed: Boolean!
    rebaseMergeAllowed: Boolean!
    forkCount: Int!
    stargazerCount: Int!
    watchers: Count!
    issues(states: [IssueState!], first: Int, after: String, orderBy: IssueOrder,
      filterBy: IssueFilters): IssueConnection!
    issue(number: Int!): Issue
    pullRequests(states: [PullRequestState!], baseRefName: String, headRefName: String,
      first: Int, after: String, orderBy: IssueOrder): PullRequestConnection!
    pullRequest(number: Int!): PullRequest
    codeOfConduct: CodeOfConduct
    contactLinks: [ContactLink!]
    defaultBranchRef: Ref
    deleteBranchOnMerge: Boolean!
    diskUsage: Int
    fundingLinks: [FundingLink!]!
    isArchived: Boolean!
    isEmpty: Boolean!
    isFork: Boolean!
    isInOrganization: Boolean!
    isMirror: Boolean!
    isPrivate: Boolean!
    isTemplate: Boolean!
    isUserConfigurationRepository: Boolean!
    licenseInfo: License
    viewerCanAdminister: Boolean!
    viewerDefaultCommitEmail: String
    viewerDefaultMergeMethod: String!
    viewerHasStarred: Boolean!
    viewerPermission: String
    viewerPossibleCommitEmails: [String!]
    viewerSubscription: String
    visibility: String!
    repositoryTopics(first: Int!): TopicConnection!
    primaryLanguage: Language
    languages(first: Int): LanguageConnection
    issueTemplates: [IssueTemplate!]
    pullRequestTemplates: [PullRequestTemplate!]
    labels(first: Int): LabelConnection
    milestones(first: Int, states: [MilestoneState!]): MilestoneConnection
    latestRelease: Release
    assignableUsers(first: Int): UserConnection!
    mentionableUsers(first: Int): UserConnection!
    projects(first: Int, states: [ProjectState!]): ProjectConnection!
    projectsV2(first: Int, query: String): ProjectV2Connection!
    issueOrPullRequest(number: Int!): IssueOrPullRequest
    ref(qualifiedName: String!): Ref
  }
  union IssueOrPullRequest = Issue | PullRequest
  type Issue {
    id: ID!
    number: Int!
    title: String!
    body: String!
    url: String!
    state: String!
    stateReason: IssueStateReason
    closed: Boolean!
    closedAt: String
    createdAt: String!
    updatedAt: String!
    author: Actor
    assignees(first: Int, after: String): UserConnection!
    labels(first: Int, after: String): LabelConnection
    milestone: Milestone
    reactionGroups: [ReactionGroup!]
    isPinned: Boolean
    repository: Repository!
    comments(first: Int!, after: String): IssueCommentConnection!
    projectCards(first: Int, after: String): ProjectCardConnection!
    projectItems(first: Int, after: String): ProjectV2ItemConnection!
    closedByPullRequestsReferences(first: Int, after: String): PullRequestConnection
  }
  type IssueConnection { nodes: [Issue!]!, totalCount: Int!, pageInfo: PageInfo! }
  type PullRequestConnection { nodes: [PullRequest!]!, totalCount: Int!, pageInfo: PageInfo! }
  type PullRequest {
    id: ID!
    repository: Repository!
    fullDatabaseId: String
    number: Int!
    title: String!
    body: String!
    state: String!
    closed: Boolean!
    url: String!
    createdAt: String!
    updatedAt: String!
    closedAt: String
    mergedAt: String
    baseRefName: String!
    baseRefOid: String!
    headRefName: String!
    headRefOid: String!
    isDraft: Boolean!
    isCrossRepository: Boolean!
    maintainerCanModify: Boolean!
    mergeable: MergeableState!
    mergeStateStatus: MergeStateStatus!
    reviewDecision: PullRequestReviewDecision
    additions: Int!
    deletions: Int!
    changedFiles: Int!
    author: Actor
    mergedBy: Actor
    headRepository: Repository
    headRepositoryOwner: RepositoryOwner
    autoMergeRequest: AutoMergeRequest
    mergeCommit: Commit
    potentialMergeCommit: Commit
    milestone: Milestone
    assignees(first: Int, after: String): UserConnection!
    labels(first: Int, after: String): LabelConnection
    reactionGroups: [ReactionGroup!]
    comments(first: Int!, after: String): IssueCommentConnection!
    reviews(first: Int, after: String): PullRequestReviewConnection
    latestReviews(first: Int, after: String): PullRequestReviewConnection
    reviewRequests(first: Int, after: String): ReviewRequestConnection
    files(first: Int, after: String): PullRequestChangedFileConnection
    commits(first: Int, last: Int, after: String): PullRequestCommitConnection!
    closingIssuesReferences(first: Int, after: String): IssueConnection
    projectCards(first: Int, after: String): ProjectCardConnection!
    projectItems(first: Int, after: String): ProjectV2ItemConnection!
  }
  type AutoMergeRequest {
    authorEmail: String, commitBody: String, commitHeadline: String,
    mergeMethod: String!, enabledAt: String, enabledBy: Actor
  }
  type Commit implements GitObject {
    oid: String!
    messageHeadline: String!
    messageBody: String!
    committedDate: String!
    authoredDate: String!
    authors(first: Int): GitActorConnection!
    statusCheckRollup: StatusCheckRollup
    history(first: Int, after: String, path: String, since: GitTimestamp,
      until: GitTimestamp): CommitHistoryConnection!
  }
  type CommitHistoryConnection { nodes: [Commit!]!, totalCount: Int!, pageInfo: PageInfo! }
  type GitActor { name: String, email: String, user: User }
  type GitActorConnection { nodes: [GitActor!]! }
  type PullRequestCommit { commit: Commit! }
  type PullRequestCommitConnection {
    nodes: [PullRequestCommit!]!, totalCount: Int!, pageInfo: PageInfo!
  }
  type StatusCheckRollup {
    contexts(first: Int, after: String): StatusCheckRollupContextConnection!
  }
  union StatusCheckRollupContext = CheckRun | StatusContext
  type StatusCheckRollupContextConnection {
    nodes: [StatusCheckRollupContext!]!, totalCount: Int!, pageInfo: PageInfo!
  }
  type Workflow { name: String! }
  type WorkflowRun { event: String!, workflow: Workflow! }
  type CheckSuite { workflowRun: WorkflowRun }
  type CheckRun {
    name: String!, status: String!, conclusion: String, startedAt: String,
    completedAt: String, detailsUrl: String, checkSuite: CheckSuite!
  }
  type StatusContext {
    context: String!, state: String!, targetUrl: String, createdAt: String!,
    description: String
  }
  type PullRequestChangedFile {
    path: String!, additions: Int!, deletions: Int!, changeType: String!
  }
  type PullRequestChangedFileConnection {
    nodes: [PullRequestChangedFile!]!, totalCount: Int!, pageInfo: PageInfo!
  }
  type PullRequestReview {
    id: ID!, author: Actor, authorAssociation: String!, body: String!,
    state: PullRequestReviewState!, submittedAt: String, commit: Commit,
    reactionGroups: [ReactionGroup!], url: String!
  }
  type PullRequestReviewConnection {
    nodes: [PullRequestReview!]!, totalCount: Int!, pageInfo: PageInfo!
  }
  type Team { name: String!, slug: String!, organization: Organization! }
  union RequestedReviewer = User | Team | Bot
  type ReviewRequest { requestedReviewer: RequestedReviewer }
  type ReviewRequestConnection { nodes: [ReviewRequest!]!, totalCount: Int!, pageInfo: PageInfo! }
  type ProjectColumn { name: String! }
  type ProjectCard { project: Project!, column: ProjectColumn }
  type ProjectCardConnection { nodes: [ProjectCard!]!, totalCount: Int! }
  type ProjectV2ItemFieldSingleSelectValue { optionId: String, name: String }
  union ProjectV2ItemFieldValue = ProjectV2ItemFieldSingleSelectValue
  type ProjectV2Item {
    id: ID!, project: ProjectV2!, fieldValueByName(name: String!): ProjectV2ItemFieldValue
  }
  type ProjectV2ItemConnection { nodes: [ProjectV2Item!]!, totalCount: Int!, pageInfo: PageInfo! }
  type IssueCommentConnection { nodes: [IssueComment!]!, totalCount: Int!, pageInfo: PageInfo! }
  type PageInfo { hasNextPage: Boolean!, endCursor: String }
  type Users { totalCount: Int! }
  type ReactionGroup { content: String!, users: Users! }
  type IssueComment {
    id: ID!, author: Actor, authorAssociation: String!, body: String!,
    createdAt: String!, includesCreatedEdit: Boolean!, isMinimized: Boolean!,
    minimizedReason: String, reactionGroups: [ReactionGroup!]!, url: String!,
    viewerDidAuthor: Boolean!
  }
`)

/**
 * Answer one GraphQL request against the fake's rows.
 *
 * A repository that does not exist is an error on its field, worded and
 * located as the vendor words it, rather than a quiet null: that is what a
 * client sees live, and what `gh` turns into
 * `GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)`.
 */
async function answer(ctx: Ctx<C>): Promise<Reply> {
  const body = jsonBodyOf(ctx)
  const result = await graphql({
    schema: SCHEMA,
    source: str(body, 'query'),
    variableValues: body.variables as Record<string, unknown> | undefined,
    rootValue: {
      repository: async ({ owner, name }: { owner: string; name: string }) => {
        const repo = await repoByName(ctx.db, ctx.tenant, `${owner}/${name}`)
        if (repo === null) {
          throw new Error(`Could not resolve to a Repository with the name '${owner}/${name}'.`)
        }
        return repositoryNode(ctx, repo)
      },
      repositoryOwner: ({ login }: { login: string }) => ownedRepositories(ctx, login),
      viewer: () => ownedRepositories(ctx, DEFAULT_LOGIN),
    },
  })
  return { status: 200, body: JSON.parse(JSON.stringify(result)) as JsonValue }
}

export function graphqlRoutes(): KitRoute<C>[] {
  return everywhere<C>(['', '/api'], (p) => [route<C>('POST', `${p}/graphql`, authedRoute(answer))])
}
