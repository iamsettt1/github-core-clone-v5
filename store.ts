// Domain operations shared by REST, GraphQL and MCP: repository JSON,
// template-serialised issues (the hot read/write shape), pull requests,
// contents commits and merges.

import {
  VIEWER_LOGIN, allocIssueDbId, allocCommentDbId, allocPrDbId, allocSeq,
  nowIso, jstr, bumpRepo, objects,
  type Repo, type Issue, type PullRequest,
} from './core.ts';
import { storeObject, makeCommit, branchFiles, threeWayMerge } from './git.ts';

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: 'main',
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

/**
 * The one issue serializer. A fixed template with per-field interpolation;
 * the same bytes populate the read cache and answer the create call, so
 * POST and GET can never disagree about the shape.
 */
export function serializeIssue(issue: Issue): string {
  let labels = '';
  for (let i = 0; i < issue.labels.length; i++) {
    if (i > 0) labels += ',';
    labels += `{"name":${jstr(issue.labels[i])}}`;
  }
  const body = issue.body === null ? 'null' : jstr(issue.body);
  return `{"id":${issue.dbId},"number":${issue.number},"title":${jstr(issue.title)},"body":${body},"state":"${issue.state}","labels":[${labels}],"user":{"login":"${VIEWER_LOGIN}"},"comments":${issue.comments.length},"created_at":"${issue.createdAt}","updated_at":"${issue.updatedAt}"}`;
}

export function refreshIssueCache(issue: Issue): void {
  issue.cached = Buffer.from(serializeIssue(issue), 'utf8');
}

export function createIssueRecord(
  repo: Repo,
  title: string,
  body: string | null,
  labels: string[],
): Issue {
  const ts = nowIso();
  const issue: Issue = {
    dbId: allocIssueDbId(),
    number: ++repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: ts,
    updatedAt: ts,
    seq: allocSeq(),
    cached: Buffer.alloc(0),
  };
  refreshIssueCache(issue);
  repo.issuesArr.push(issue);
  repo.issuesMap.set(issue.number, issue);
  return issue;
}

export function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.dbId,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: { login: VIEWER_LOGIN },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
  };
}

export function createPrRecord(
  repo: Repo,
  title: string,
  body: string | null,
  head: string,
  base: string,
): PullRequest {
  const ts = nowIso();
  const pr: PullRequest = {
    dbId: allocPrDbId(),
    number: ++repo.prSeq,
    title,
    body,
    head,
    base,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha: repo.refs.get(`refs/heads/${head}`) ?? '',
    baseSha: repo.refs.get(`refs/heads/${base}`) ?? '',
    createdAt: ts,
    updatedAt: ts,
    seq: allocSeq(),
  };
  repo.prsArr.push(pr);
  repo.prsMap.set(pr.number, pr);
  return pr;
}

/** Attempt the squash merge; returns 'merged' | 'conflict' | 'missing'. */
export function mergePr(repo: Repo, pr: PullRequest): { outcome: string; sha?: string } {
  const baseRef = `refs/heads/${pr.base}`;
  const headRef = `refs/heads/${pr.head}`;
  const outcome = threeWayMerge(repo, baseRef, headRef);
  if (!outcome) return { outcome: 'missing' };
  if (outcome.conflict) return { outcome: 'conflict' };
  const baseTip = repo.refs.get(baseRef) as string;
  const sha = makeCommit(outcome.files, baseTip, pr.title);
  repo.refs.set(baseRef, sha);
  bumpRepo(repo);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = nowIso();
  pr.mergeCommitSha = sha;
  pr.updatedAt = pr.mergedAt;
  return { outcome: 'merged', sha };
}

export type ContentResult =
  | { status: 201 | 200; blobOid: string; commitOid: string; size: number }
  | { status: 409 }
  | { status: 404 };

/** Create or update one file on a branch, committing on top of its tip. */
export function putContent(
  repo: Repo,
  path: string,
  content: Buffer,
  branch: string,
  shaGiven: string | undefined,
  message: string,
): ContentResult {
  const ref = `refs/heads/${branch}`;
  let parent: string | null;
  let files: Map<string, string>;
  if (repo.refs.has(ref)) {
    parent = repo.refs.get(ref) as string;
    files = new Map<string, string>();
    for (const [p, ent] of branchFiles(repo, ref)) files.set(p, ent.blob);
  } else if (branch !== 'main' && repo.refs.has('refs/heads/main')) {
    parent = repo.refs.get('refs/heads/main') as string;
    files = new Map<string, string>();
    for (const [p, ent] of branchFiles(repo, 'refs/heads/main')) files.set(p, ent.blob);
  } else {
    parent = null;
    files = new Map<string, string>();
  }
  const existing = files.get(path);
  if (existing !== undefined) {
    if (shaGiven === undefined || shaGiven !== existing) return { status: 409 };
  }
  const blobOid = storeObject('blob', content);
  files.set(path, blobOid);
  const commitOid = makeCommit(files, parent, message || 'Update file');
  repo.refs.set(ref, commitOid);
  bumpRepo(repo);
  return { status: existing !== undefined ? 200 : 201, blobOid, commitOid, size: content.length };
}

export function deleteContent(
  repo: Repo,
  path: string,
  branch: string,
  message: string,
): { status: 200; commitOid: string } | { status: 404 } {
  const ref = `refs/heads/${branch}`;
  if (!repo.refs.has(ref)) return { status: 404 };
  const files = new Map<string, string>();
  for (const [p, ent] of branchFiles(repo, ref)) files.set(p, ent.blob);
  if (!files.has(path)) return { status: 404 };
  files.delete(path);
  const parent = repo.refs.get(ref) as string;
  const commitOid = makeCommit(files, parent, message || 'Delete file');
  repo.refs.set(ref, commitOid);
  bumpRepo(repo);
  return { status: 200, commitOid };
}

export function addCommentRecord(repo: Repo, issue: Issue, body: string): { dbId: number; body: string; createdAt: string; updatedAt: string } {
  const ts = nowIso();
  const comment = { dbId: allocCommentDbId(), body, createdAt: ts, updatedAt: ts };
  issue.comments.push({ dbId: comment.dbId, body, createdAt: ts, updatedAt: ts });
  issue.updatedAt = ts;
  refreshIssueCache(issue);
  void repo;
  return comment;
}

export { objects };
