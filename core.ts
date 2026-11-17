// Shared in-memory state for the forge: identity, counters, object and
// repository stores, global-id helpers. Everything lives in Maps so the
// hot paths stay O(1).

// Failed inflate probes are control flow on the pack-parsing hot path
// (several per entry); stack capture/formatting for those throws costs
// more than the inflate work itself, so trim it process-wide. Nothing in
// this process ever reads a stack trace.
Error.stackTraceLimit = 0;
Error.prepareStackTrace = () => '';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
  gen: number; // commit generation, -1 until known; unused for other types
  parents: string[];
  tree: string;
}

export interface IssueComment {
  dbId: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  dbId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
  cached: Buffer;
}

export interface PullRequest {
  dbId: number;
  number: number;
  title: string;
  body: string | null;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface FileEnt {
  blob: string;
  size: number;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  labels: Map<string, { name: string; color: string }>;
  issuesArr: Issue[];
  issuesMap: Map<number, Issue>;
  issueSeq: number;
  prsArr: PullRequest[];
  prsMap: Map<number, PullRequest>;
  prSeq: number;
  refs: Map<string, string>;
  version: number;
  fileCache: Map<string, Map<string, FileEnt>>;
  fetchCache: Map<string, Buffer>;
  advCache: Map<string, Buffer>;
  lsCache: Map<string, Buffer>;
}

export const objects = new Map<string, GitObj>();
export const packEntryCache = new Map<string, Buffer>();
export const repos = new Map<string, Repo>();
export const reposByDbId = new Map<number, Repo>();
export const repoOrder: Repo[] = [];

export let nextRepoDbId = 5000;
export let nextIssueDbId = 1;
export let nextCommentDbId = 1;
export let nextPrDbId = 1;
export let globalSeq = 1;

export function allocRepoDbId(): number { return nextRepoDbId++; }
export function allocIssueDbId(): number { return nextIssueDbId++; }
export function allocCommentDbId(): number { return nextCommentDbId++; }
export function allocPrDbId(): number { return nextPrDbId++; }
export function allocSeq(): number { return globalSeq++; }

export function nowIso(): string {
  return new Date().toISOString();
}

export function gidEncode(namespaced: string): string {
  return Buffer.from(namespaced, 'utf8').toString('base64url');
}

export function gidDecode(gid: string): string {
  try {
    return Buffer.from(gid, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export function repoGid(repo: Repo): string {
  return gidEncode(`repo:${repo.owner}:${repo.name}`);
}

export function issueGid(repo: Repo, issue: Issue): string {
  return gidEncode(`issue:${repo.dbId}:${issue.number}`);
}

export function prGid(repo: Repo, pr: PullRequest): string {
  return gidEncode(`pr:${repo.dbId}:${pr.number}`);
}

export function commentGid(repo: Repo, issue: Issue, comment: IssueComment): string {
  return gidEncode(`comment:${repo.dbId}:${issue.number}:${comment.dbId}`);
}

/** Mark a repo mutated: every version-keyed cache for it is dropped. */
export function bumpRepo(repo: Repo): void {
  repo.version += 1;
  repo.fetchCache.clear();
  repo.advCache.clear();
  repo.lsCache.clear();
  repo.fileCache.clear();
}

export function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const ts = nowIso();
  const repo: Repo = {
    dbId: allocRepoDbId(),
    owner: VIEWER_LOGIN,
    name,
    fullName: `${VIEWER_LOGIN}/${name}`,
    description: description ?? '',
    isPrivate: !!isPrivate,
    createdAt: ts,
    updatedAt: ts,
    labels: new Map(),
    issuesArr: [],
    issuesMap: new Map(),
    issueSeq: 0,
    prsArr: [],
    prsMap: new Map(),
    prSeq: 0,
    refs: new Map(),
    version: 1,
    fileCache: new Map(),
    fetchCache: new Map(),
    advCache: new Map(),
    lsCache: new Map(),
  };
  repos.set(repo.fullName, repo);
  reposByDbId.set(repo.dbId, repo);
  repoOrder.push(repo);
  return repo;
}

/** JSON string literal for one value (used by the template serializers). */
export function jstr(value: string): string {
  return JSON.stringify(value);
}
