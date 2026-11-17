// GraphQL v4: a small hand-written executor — tokeniser, recursive-descent
// parser for documents (operations, fragments, aliases, variables), and a
// resolver table over the shared store. No string matching on documents.

import {
  repos, reposByDbId, gidDecode, repoGid, issueGid, prGid, commentGid,
  VIEWER_LOGIN,
  type Repo, type Issue, type PullRequest,
} from './core.ts';
import { createIssueRecord, createPrRecord, mergePr, addCommentRecord } from './store.ts';
import { threeWayMerge } from './git.ts';

// ---------- tokeniser ----------

interface Tok { kind: string; value: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.startsWith('...', i)) { toks.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:=!$@'.includes(c)) { toks.push({ kind: c, value: c }); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ kind: 'string', value: src.slice(i + 3, end === -1 ? src.length : end) });
        i = end === -1 ? src.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else { out += src[j]; j++; }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++;
      toks.push({ kind: 'number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i++;
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------- parser ----------

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}
interface FragmentNode { kind: 'inline' | 'spread'; typeCond: string | null; name: string | null; selection: SelectionNode[] | null }
type SelectionNode = FieldNode | FragmentNode;

interface Operation { type: 'query' | 'mutation'; selection: SelectionNode[] }

class Parser {
  private toks: Tok[];
  private pos = 0;
  fragments = new Map<string, { typeCond: string; selection: SelectionNode[] }>();

  constructor(src: string) { this.toks = tokenize(src); }

  private peek(): Tok { return this.toks[this.pos]; }
  private next(): Tok { return this.toks[this.pos++]; }
  private expect(kind: string): Tok {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind}`);
    return t;
  }
  private skip(kind: string): boolean {
    if (this.peek().kind === kind) { this.pos++; return true; }
    return false;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === '{') {
        ops.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        this.next();
        if (this.peek().kind === 'name') this.next(); // operation name
        if (this.peek().kind === '(') this.parseVarDefs();
        this.skipDirectives();
        ops.push({ type: t.value as 'query' | 'mutation', selection: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expect('name').value;
        this.expect('name'); // 'on'
        const typeCond = this.expect('name').value;
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        this.fragments.set(name, { typeCond, selection });
      } else {
        this.next();
      }
    }
    return ops;
  }

  private parseVarDefs(): void {
    this.expect('(');
    while (this.peek().kind !== ')') {
      this.expect('$');
      this.expect('name');
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) { this.parseType(); this.expect(']'); }
    else this.expect('name');
    this.skip('!');
  }

  private skipDirectives(): void {
    while (this.skip('@')) {
      this.expect('name');
      if (this.peek().kind === '(') this.parseArgs();
    }
  }

  private parseArgs(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    this.expect('(');
    while (this.peek().kind !== ')') {
      const name = this.expect('name').value;
      this.expect(':');
      args[name] = this.parseValue();
    }
    this.expect(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.peek();
    if (t.kind === '$') { this.next(); return { kind: 'var', name: this.expect('name').value }; }
    if (t.kind === 'string') { this.next(); return { kind: 'string', value: t.value }; }
    if (t.kind === 'number') { this.next(); return { kind: 'number', value: Number(t.value) }; }
    if (t.kind === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (this.peek().kind !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t.kind === '{') {
      this.next();
      const fields: Record<string, ValueNode> = {};
      while (this.peek().kind !== '}') {
        const name = this.expect('name').value;
        this.expect(':');
        fields[name] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      this.next();
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.kind}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek().kind !== '}') {
      if (this.peek().kind === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.toks[this.pos].value !== 'on') {
          const name = this.next().value;
          this.skipDirectives();
          out.push({ kind: 'spread', typeCond: null, name, selection: null });
        } else {
          let typeCond: string | null = null;
          if (this.peek().kind === 'name') { this.next(); typeCond = this.expect('name').value; }
          this.skipDirectives();
          out.push({ kind: 'inline', typeCond, name: null, selection: this.parseSelectionSet() });
        }
      } else {
        let name = this.expect('name').value;
        let alias: string | null = null;
        if (this.skip(':')) { alias = name; name = this.expect('name').value; }
        const args = this.peek().kind === '(' ? this.parseArgs() : {};
        this.skipDirectives();
        const selection = this.peek().kind === '{' ? this.parseSelectionSet() : null;
        out.push({ kind: 'field', name, alias, args, selection });
      }
    }
    this.expect('}');
    return out;
  }
}

// ---------- execution ----------

interface Ctx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCond: string; selection: SelectionNode[] }>;
  errors: { message: string }[];
}

type Wrap = Record<string, unknown> & { __type: string };

const wrap = (type: string, data: Record<string, unknown>): Wrap => ({ __type: type, ...data });

function evalValue(node: ValueNode, ctx: Ctx): unknown {
  switch (node.kind) {
    case 'var': return ctx.variables[node.name];
    case 'string': return node.value;
    case 'number': return node.value;
    case 'bool': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((i) => evalValue(i, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node.fields)) out[k] = evalValue(v, ctx);
      return out;
    }
  }
}

function evalArgs(node: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.args)) out[k] = evalValue(v, ctx);
  return out;
}

const userWrap = (): Wrap => wrap('User', { login: VIEWER_LOGIN });

function repoWrap(repo: Repo): Wrap { return wrap('Repository', { repo }); }
function issueWrap(repo: Repo, issue: Issue): Wrap { return wrap('Issue', { repo, issue }); }
function prWrap(repo: Repo, pr: PullRequest): Wrap { return wrap('PullRequest', { repo, pr }); }

function findRepoByGid(gid: string): Repo | null {
  const decoded = gidDecode(gid);
  if (decoded.startsWith('repo:')) {
    const rest = decoded.slice(5);
    const slash = rest.indexOf(':');
    if (slash !== -1) {
      const full = `${rest.slice(0, slash)}/${rest.slice(slash + 1)}`;
      return repos.get(full) ?? null;
    }
  }
  const byId = Number(decoded.split(':')[1]);
  if (Number.isFinite(byId) && reposByDbId.has(byId)) return reposByDbId.get(byId) as Repo;
  return null;
}

function nodeForId(gid: string): Wrap | null {
  const decoded = gidDecode(gid);
  const parts = decoded.split(':');
  if (parts[0] === 'repo') {
    const repo = findRepoByGid(gid);
    return repo ? repoWrap(repo) : null;
  }
  if (parts[0] === 'issue' || parts[0] === 'pr') {
    const repo = reposByDbId.get(Number(parts[1]));
    if (!repo) return null;
    const num = Number(parts[2]);
    if (parts[0] === 'issue') {
      const issue = repo.issuesMap.get(num);
      return issue ? issueWrap(repo, issue) : null;
    }
    const pr = repo.prsMap.get(num);
    return pr ? prWrap(repo, pr) : null;
  }
  if (parts[0] === 'comment') {
    const repo = reposByDbId.get(Number(parts[1]));
    if (!repo) return null;
    const issue = repo.issuesMap.get(Number(parts[2]));
    if (!issue) return null;
    const comment = issue.comments.find((c) => c.dbId === Number(parts[3]));
    if (!comment) return null;
    return wrap('IssueComment', { repo, issue, comment });
  }
  if (parts[0] === 'user') return userWrap();
  return null;
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Wrap {
  let list = [...repo.issuesArr];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => want.has(i.state.toUpperCase()));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy && String(orderBy.direction).toUpperCase() === 'DESC') list.reverse();
  return paginate(list.map((i) => issueWrap(repo, i)), list.map((i) => i.number), args, 'IssueConnection');
}

function prsConnection(repo: Repo, args: Record<string, unknown>): Wrap {
  let list = [...repo.prsArr];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((p) => want.has(p.merged ? 'MERGED' : p.state.toUpperCase()));
  }
  return paginate(list.map((p) => prWrap(repo, p)), list.map((p) => p.number), args, 'PullRequestConnection');
}

function paginate(nodes: Wrap[], numbers: number[], args: Record<string, unknown>, type: string): Wrap {
  let start = 0;
  const after = args.after as string | undefined;
  if (typeof after === 'string' && after) {
    const decoded = gidDecode(after);
    const num = Number(decoded);
    if (Number.isFinite(num)) {
      const idx = numbers.indexOf(num);
      if (idx !== -1) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  const slice = nodes.slice(start, start + Math.max(0, first));
  const sliceNums = numbers.slice(start, start + Math.max(0, first));
  const hasNext = start + slice.length < nodes.length;
  const endCursor = sliceNums.length > 0
    ? Buffer.from(String(sliceNums[sliceNums.length - 1]), 'utf8').toString('base64url')
    : null;
  return wrap(type, {
    nodes: slice,
    pageInfo: wrap('PageInfo', {
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      endCursor,
      startCursor: sliceNums.length > 0
        ? Buffer.from(String(sliceNums[0]), 'utf8').toString('base64url')
        : null,
    }),
    totalCount: nodes.length,
  });
}

function prFiles(repo: Repo, pr: PullRequest): { path: string }[] {
  // Paths differing between base and head branch file maps.
  const { branchFiles } = requireBranchFiles;
  const base = branchFiles(repo, `refs/heads/${pr.base}`);
  const head = branchFiles(repo, `refs/heads/${pr.head}`);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: { path: string }[] = [];
  for (const p of paths) {
    const b = base.get(p);
    const h = head.get(p);
    if (!b || !h || b.blob !== h.blob) out.push({ path: p });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

// Late-bound to avoid a static cycle in module init order.
import { branchFiles as branchFilesFn } from './git.ts';
const requireBranchFiles = { branchFiles: branchFilesFn };

function prMergeable(repo: Repo, pr: PullRequest): string {
  const baseRef = `refs/heads/${pr.base}`;
  const headRef = `refs/heads/${pr.head}`;
  if (!repo.refs.has(baseRef) || !repo.refs.has(headRef)) return 'UNKNOWN';
  const outcome = threeWayMerge(repo, baseRef, headRef);
  if (!outcome) return 'UNKNOWN';
  return outcome.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'databaseId', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'databaseId', 'author', 'createdAt', 'updatedAt', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  User: ['login', 'id', 'databaseId', 'name', 'email'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  Ref: ['name', 'prefix', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'WRITE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function resolveField(typeName: string, source: Wrap | null, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  if (field === '__typename') return typeName;

  if (typeName === 'Query') {
    switch (field) {
      case 'viewer': return userWrap();
      case 'repository': {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        if (owner !== VIEWER_LOGIN) return null;
        const repo = repos.get(`${owner}/${name}`);
        return repo ? repoWrap(repo) : null;
      }
      case 'node': return nodeForId(String(args.id ?? ''));
      case '__type': {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] || ENUM_VALUES[name]) return wrap('__Type', { name });
        return null;
      }
      case '__schema': return wrap('__Schema', {});
      case 'search': return wrap('SearchResultItemConnection', { nodes: [], pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }), issueCount: 0 });
    }
  }

  if (typeName === 'Mutation') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (field) {
      case 'createIssue': {
        const repo = findRepoByGid(String(input.repositoryId ?? ''));
        if (!repo) return wrap('CreateIssuePayload', { issue: null });
        const labels = Array.isArray(input.labelIds) ? [] : [];
        void labels;
        const issue = createIssueRecord(repo, String(input.title ?? ''), input.body === undefined || input.body === null ? null : String(input.body), []);
        return wrap('CreateIssuePayload', { issue: issueWrap(repo, issue) });
      }
      case 'closeIssue': {
        const node = nodeForId(String(input.issueId ?? ''));
        if (node && node.__type === 'Issue') {
          const issue = node.issue as Issue;
          issue.state = 'closed';
          issue.updatedAt = new Date().toISOString();
          const { refreshIssueCache } = refreshRef;
          refreshIssueCache(issue);
          return wrap('CloseIssuePayload', { issue: node });
        }
        return wrap('CloseIssuePayload', { issue: null });
      }
      case 'createPullRequest': {
        const repo = findRepoByGid(String(input.repositoryId ?? ''));
        if (!repo) return wrap('CreatePullRequestPayload', { pullRequest: null });
        const pr = createPrRecord(
          repo,
          String(input.title ?? ''),
          input.body === undefined || input.body === null ? null : String(input.body),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        return wrap('CreatePullRequestPayload', { pullRequest: prWrap(repo, pr) });
      }
      case 'mergePullRequest': {
        const node = nodeForId(String(input.pullRequestId ?? ''));
        if (node && node.__type === 'PullRequest') {
          const repo = node.repo as Repo;
          const pr = node.pr as PullRequest;
          if (!pr.merged) mergePr(repo, pr);
          return wrap('MergePullRequestPayload', { pullRequest: node });
        }
        return wrap('MergePullRequestPayload', { pullRequest: null });
      }
      case 'addComment': {
        const node = nodeForId(String(input.subjectId ?? ''));
        if (node && node.__type === 'Issue') {
          const repo = node.repo as Repo;
          const issue = node.issue as Issue;
          const comment = addCommentRecord(repo, issue, String(input.body ?? ''));
          const commentWrap = wrap('IssueComment', { repo, issue, comment: { dbId: comment.dbId, body: comment.body, createdAt: comment.createdAt, updatedAt: comment.updatedAt } });
          return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node: commentWrap }) });
        }
        return wrap('AddCommentPayload', { commentEdge: null });
      }
    }
  }

  if (!source) return undefined;

  if (typeName === 'User') {
    switch (field) {
      case 'login': return VIEWER_LOGIN;
      case 'databaseId': return 1000;
      case 'id': return Buffer.from('user:1000', 'utf8').toString('base64url');
      case 'name': return 'ada iversen';
      case 'email': return 'adaiversen@example.invalid';
    }
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    switch (field) {
      case 'id': return repoGid(repo);
      case 'databaseId': return repo.dbId;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return userWrap();
      case 'defaultBranchRef': return wrap('Ref', { name: 'main', prefix: 'refs/heads/', repo });
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'isPrivate': return repo.isPrivate;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'url': return `https://github.invalid/${repo.fullName}`;
      case 'issue': {
        const issue = repo.issuesMap.get(Number(args.number));
        return issue ? issueWrap(repo, issue) : null;
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequest': {
        const pr = repo.prsMap.get(Number(args.number));
        return pr ? prWrap(repo, pr) : null;
      }
      case 'pullRequests': return prsConnection(repo, args);
    }
  }

  if (typeName === 'Issue') {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    switch (field) {
      case 'id': return issueGid(repo, issue);
      case 'databaseId': return issue.dbId;
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state.toUpperCase();
      case 'body': return issue.body;
      case 'author': return userWrap();
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'url': return `https://github.invalid/${repo.fullName}/issues/${issue.number}`;
    }
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as Repo;
    const pr = source.pr as PullRequest;
    switch (field) {
      case 'id': return prGid(repo, pr);
      case 'databaseId': return pr.dbId;
      case 'number': return pr.number;
      case 'title': return pr.title;
      case 'body': return pr.body;
      case 'state': return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      case 'merged': return pr.merged;
      case 'headRefName': return pr.head;
      case 'baseRefName': return pr.base;
      case 'mergeable': return prMergeable(repo, pr);
      case 'author': return userWrap();
      case 'createdAt': return pr.createdAt;
      case 'updatedAt': return pr.updatedAt;
      case 'url': return `https://github.invalid/${repo.fullName}/pull/${pr.number}`;
      case 'files': {
        const files = prFiles(repo, pr);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => wrap('PullRequestFile', { path: f.path }));
        return wrap('PullRequestFilesConnection', {
          nodes,
          pageInfo: wrap('PageInfo', { hasNextPage: files.length > nodes.length, hasPreviousPage: false, endCursor: null, startCursor: null }),
          totalCount: files.length,
        });
      }
    }
  }

  if (typeName === 'IssueComment') {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    const comment = source.comment as { dbId: number; body: string; createdAt: string; updatedAt: string };
    switch (field) {
      case 'id': return commentGid(repo, issue, comment as never);
      case 'body': return comment.body;
      case 'author': return userWrap();
      case 'createdAt': return comment.createdAt;
      case 'updatedAt': return comment.updatedAt;
    }
  }

  if (typeName === 'Ref') {
    switch (field) {
      case 'name': return source.name;
      case 'prefix': return source.prefix;
      case 'target': return null;
    }
  }

  if (typeName === 'PageInfo' || typeName.endsWith('Connection') || typeName === 'PullRequestFilesConnection' || typeName === 'SearchResultItemConnection') {
    if (field === 'nodes') return source.nodes;
    if (field === 'pageInfo') return source.pageInfo;
    if (field === 'totalCount') return source.totalCount;
    if (field === 'issueCount') return source.issueCount ?? 0;
    if (field === 'edges') {
      const nodes = (source.nodes as Wrap[]) ?? [];
      return nodes.map((n) => wrap('Edge', { node: n, cursor: null }));
    }
  }

  if (typeName === 'Edge') {
    if (field === 'node') return source.node;
    if (field === 'cursor') return source.cursor;
  }

  if (typeName.endsWith('Payload')) {
    if (field === 'issue') return source.issue;
    if (field === 'pullRequest') return source.pullRequest;
    if (field === 'commentEdge') return source.commentEdge;
    if (field === 'clientMutationId') return null;
  }
  if (typeName === 'IssueCommentEdge') {
    if (field === 'node') return source.node;
    if (field === 'cursor') return null;
  }

  if (typeName === '__Type') {
    const name = source.name as string;
    switch (field) {
      case 'name': return name;
      case 'kind': return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
      case 'description': return null;
      case 'fields': return (TYPE_FIELDS[name] ?? []).map((f) => wrap('__Field', { name: f }));
      case 'enumValues': return (ENUM_VALUES[name] ?? []).map((v) => wrap('__EnumValue', { name: v }));
      case 'possibleTypes': return null;
      case 'inputFields': return null;
      case 'interfaces': return [];
      case 'ofType': return null;
    }
  }
  if (typeName === '__Field') {
    if (field === 'name') return source.name;
    if (field === 'description') return null;
    if (field === 'args') return [];
    if (field === 'type') return wrap('__Type', { name: 'String' });
    if (field === 'isDeprecated') return false;
    if (field === 'deprecationReason') return null;
  }
  if (typeName === '__EnumValue') {
    if (field === 'name') return source.name;
    if (field === 'description') return null;
    if (field === 'isDeprecated') return false;
    if (field === 'deprecationReason') return null;
  }
  if (typeName === '__Schema') {
    if (field === 'queryType') return wrap('__Type', { name: 'Query' });
    if (field === 'mutationType') return wrap('__Type', { name: 'Mutation' });
    if (field === 'types') return Object.keys(TYPE_FIELDS).map((n) => wrap('__Type', { name: n }));
  }

  // Plain data carried on a wrapper (PageInfo cursors, file paths, ...).
  if (field in source && field !== '__type') return source[field];

  return undefined;
}

import { refreshIssueCache as refreshIssueCacheFn } from './store.ts';
const refreshRef = { refreshIssueCache: refreshIssueCacheFn };

function completeValue(value: unknown, selection: SelectionNode[] | null, ctx: Ctx, parentType: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(v, selection, ctx, parentType));
  if (typeof value === 'object') {
    const w = value as Wrap;
    if (w.__type && selection) return executeSelection(w.__type, w, selection, ctx);
    if (w.__type && !selection) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(w)) if (k !== '__type') out[k] = v;
      return out;
    }
    return value;
  }
  return value;
}

function executeSelection(typeName: string, source: Wrap | null, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inline') {
      if (!sel.typeCond || sel.typeCond === typeName) {
        Object.assign(out, executeSelection(typeName, source, sel.selection ?? [], ctx));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name ?? '');
      if (frag && frag.typeCond === typeName) {
        Object.assign(out, executeSelection(typeName, source, frag.selection, ctx));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const args = evalArgs(sel, ctx);
    const value = resolveField(typeName, source, sel.name, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, sel.selection, ctx, typeName);
  }
  return out;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const parser = new Parser(query);
  const ops = parser.parseDocument();
  const ctx: Ctx = { variables: variables ?? {}, fragments: parser.fragments, errors: [] };
  const op = ops[0];
  if (!op) return { data: {} };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, op.selection, ctx);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
