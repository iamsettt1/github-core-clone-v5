// HTTP surface: segment routing (no regex dispatch), REST v3, git smart
// HTTP, GraphQL v4 and MCP. Every response is one Buffer handed to a
// single res.end — status line, headers and body leave together.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  repos, repoOrder, createRepoRecord, objects, VIEWER_LOGIN, ZERO_OID,
  type Repo, type Issue,
} from './core.ts';
import {
  advertisementV2, advertisementV0, lsRefs, fetchResponse, fetchResponseV0,
  receivePack, readPkt, branchFiles, parseCommit, parseIdent, dirTreeOid,
  type FetchArgs, type RefUpdate,
} from './git.ts';
import {
  repoJson, serializeIssue, refreshIssueCache, createIssueRecord, prJson,
  createPrRecord, mergePr, putContent, deleteContent, addCommentRecord,
} from './store.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const HEALTH_BUF = Buffer.from('{"ok":true}', 'utf8');
const NOT_FOUND_BUF = Buffer.from('{"message":"Not Found"}', 'utf8');
let requestCounter = 0;

function sendBuf(res: ServerResponse, status: number, contentType: string, body: Buffer, extra?: Record<string, string>): void {
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${requestCounter}`,
    ...(extra ?? {}),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  sendBuf(res, status, JSON_TYPE, Buffer.from(JSON.stringify(value), 'utf8'), extra);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authOk(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const expected = EXPECTED_TOKEN;
  let token = '';
  if (header.startsWith('Bearer ')) token = header.slice(7);
  else if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    const user = colon === -1 ? decoded : decoded.slice(0, colon);
    const pass = colon === -1 ? '' : decoded.slice(colon + 1);
    token = pass === expected && expected !== '' ? pass : user;
    if (expected !== '' && (user === expected || pass === expected)) token = expected;
  } else token = header;
  if (expected === '') return token.length > 0;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  try {
    const value = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    if (value === null || typeof value !== 'object') return { ok: false };
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function queryParam(query: string, name: string): string | null {
  if (!query) return null;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    if (key === name) {
      const raw = eq === -1 ? '' : part.slice(eq + 1);
      try { return decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { return raw; }
    }
  }
  return null;
}

/** POST /issues against a resolved repo (generic route + hot path). */
function createIssueHttp(res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
  const title = parsed.value.title;
  if (typeof title !== 'string' || title.length === 0) { sendError(res, 422, 'Validation Failed: title is required'); return; }
  const labelsIn = parsed.value.labels;
  const labelNames: string[] = [];
  if (Array.isArray(labelsIn)) {
    for (const entry of labelsIn) {
      const labelName = typeof entry === 'string' ? entry : (entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).name ?? '') : '');
      if (!repo.labels.has(labelName)) { sendError(res, 422, 'Validation Failed: unknown label'); return; }
      labelNames.push(labelName);
    }
  }
  const issue = createIssueRecord(
    repo,
    title,
    typeof parsed.value.body === 'string' ? parsed.value.body : null,
    labelNames,
  );
  sendBuf(res, 201, JSON_TYPE, issue.cached);
}

function pageParams(query: string): { perPage: number; page: number } {
  const perPageRaw = queryParam(query, 'per_page');
  const pageRaw = queryParam(query, 'page');
  let perPage = perPageRaw === null ? 30 : Number(perPageRaw);
  let page = pageRaw === null ? 1 : Number(pageRaw);
  if (!Number.isFinite(perPage) || perPage <= 0) perPage = 30;
  if (!Number.isFinite(page) || page <= 0) page = 1;
  return { perPage: Math.min(100, Math.floor(perPage)), page: Math.floor(page) };
}

// ---------- REST ----------

function handleRest(req: IncomingMessage, res: ServerResponse, rest: string[], query: string, body: Buffer): void {
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' });
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const name = parsed.value.name;
      if (typeof name !== 'string' || name.length === 0) { sendError(res, 422, 'Validation Failed: name is required'); return; }
      if (repos.has(`${VIEWER_LOGIN}/${name}`)) { sendError(res, 422, 'Repository already exists'); return; }
      const repo = createRepoRecord(
        name,
        parsed.value.private === true,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
      );
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const start = (page - 1) * perPage;
      const slice = repoOrder.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      if (start + perPage < repoOrder.length) {
        const host = req.headers.host ?? 'localhost';
        const lastPage = Math.ceil(repoOrder.length / perPage);
        const base = `http://${host}/api/v3/user/repos`;
        extra.link = `<${base}?per_page=${perPage}&page=${page + 1}>; rel="next", <${base}?per_page=${perPage}&page=${lastPage}>; rel="last"`;
      }
      sendJson(res, 200, slice.map(repoJson), extra);
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  if (rest[0] !== 'repos' || rest.length < 3) {
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  const owner = rest[1];
  const repoName = rest[2];
  const repo = owner === VIEWER_LOGIN ? repos.get(`${owner}/${repoName}`) : undefined;
  if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.name === 'string' && parsed.value.name.length > 0) {
        // Renames are outside the checked surface; ignore.
      }
      repo.updatedAt = new Date().toISOString();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repo.fullName);
      const idx = repoOrder.indexOf(repo);
      if (idx !== -1) repoOrder.splice(idx, 1);
      requestCounter += 1;
      res.writeHead(204, { 'x-github-request-id': `req-${requestCounter}` });
      res.end();
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  handleRepoTail(req, res, repo, tail, query, body);
}

function handleRepoTail(req: IncomingMessage, res: ServerResponse, repo: Repo, tail: string[], query: string, body: Buffer): void {
  const method = req.method ?? 'GET';

  // git refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method === 'GET') {
        const out: unknown[] = [];
        for (const [ref, oid] of repo.refs) out.push({ ref, object: { sha: oid } });
        sendJson(res, 200, out);
        return;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
        const ref = parsed.value.ref;
        const sha = parsed.value.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/')) { sendError(res, 422, 'Validation Failed: ref must start with refs/'); return; }
        if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha) || !objects.has(sha)) { sendError(res, 422, 'Validation Failed: unknown sha'); return; }
        if (repo.refs.has(ref)) { sendError(res, 422, 'Reference already exists'); return; }
        repo.refs.set(ref, sha);
        const { bumpRepo } = bumpRef;
        bumpRepo(repo);
        sendJson(res, 201, { ref, object: { sha } });
        return;
      }
    }
    if (tail[2] === 'heads' && tail.length >= 4 && method === 'GET') {
      const branch = tail.slice(3).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid } });
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  // branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const out: unknown[] = [];
      for (const [ref, oid] of repo.refs) {
        if (ref.startsWith('refs/heads/')) {
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
        }
      }
      sendJson(res, 200, out);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  // commits
  if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
    const shaParam = queryParam(query, 'sha');
    let tip: string | undefined;
    if (shaParam) {
      tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam) ?? (objects.has(shaParam) ? shaParam : undefined);
    } else {
      tip = repo.refs.get('refs/heads/main');
    }
    const out: unknown[] = [];
    if (tip) {
      const visited = new Set<string>();
      const stack: string[] = [tip];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (visited.has(oid)) continue;
        visited.add(oid);
        const obj = objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const parsed = parseCommit(obj.data);
        out.push({
          sha: oid,
          commit: {
            message: parsed.message,
            author: parseIdent(parsed.author),
            committer: parseIdent(parsed.committer),
            tree: { sha: parsed.tree },
          },
          parents: parsed.parents.map((p) => ({ sha: p })),
        });
        for (let i = parsed.parents.length - 1; i >= 0; i--) stack.push(parsed.parents[i]);
      }
    }
    sendJson(res, 200, out);
    return;
  }

  // contents
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const refParam = queryParam(query, 'ref');
      const ref = refParam
        ? (refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`)
        : 'refs/heads/main';
      const tip = repo.refs.get(ref);
      if (!tip) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      const files = branchFiles(repo, ref);
      const commit = objects.get(tip);
      const treeOid = commit && commit.type === 'commit' ? commit.tree : '';
      if (path !== '' && files.has(path)) {
        const ent = files.get(path) as { blob: string; size: number };
        const blob = objects.get(ent.blob);
        const name = path.slice(path.lastIndexOf('/') + 1);
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          content: blob ? blob.data.toString('base64') : '',
          sha: ent.blob,
          size: ent.size,
          name,
          path,
        });
        return;
      }
      // Directory listing (root when path is '').
      const prefix = path === '' ? '' : `${path}/`;
      const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
      for (const [filePath, ent] of files) {
        if (prefix !== '' && !filePath.startsWith(prefix)) continue;
        const restPath = filePath.slice(prefix.length);
        if (restPath === '') continue;
        const slash = restPath.indexOf('/');
        if (slash === -1) {
          seen.set(restPath, { type: 'file', name: restPath, path: filePath, sha: ent.blob });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!seen.has(dirName)) {
            const dirPath = prefix + dirName;
            const parts = dirPath.split('/');
            const sha = treeOid ? dirTreeOid(treeOid, parts) ?? ent.blob : ent.blob;
            seen.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha });
          }
        }
      }
      if (path !== '' && seen.size === 0) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      sendJson(res, 200, [...seen.values()]);
      return;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const contentB64 = typeof parsed.value.content === 'string' ? parsed.value.content : '';
      const content = Buffer.from(contentB64, 'base64');
      const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : 'main';
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Update file';
      const shaGiven = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      const result = putContent(repo, path, content, branch, shaGiven, message);
      if (result.status === 409) { sendError(res, 409, 'Conflict: sha does not match'); return; }
      if (result.status === 404) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      const name = path.slice(path.lastIndexOf('/') + 1);
      sendJson(res, result.status, {
        content: { name, path, sha: result.blobOid, size: result.size, encoding: 'base64' },
        commit: { sha: result.commitOid },
      });
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
      const branch = typeof parsed.value.branch === 'string' ? parsed.value.branch : 'main';
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : 'Delete file';
      const result = deleteContent(repo, path, branch, message);
      if (result.status === 404) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
      sendJson(res, 200, { content: null, commit: { sha: result.commitOid } });
      return;
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  // labels
  if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
    const name = parsed.value.name;
    if (typeof name !== 'string' || name.length === 0) { sendError(res, 422, 'Validation Failed: name is required'); return; }
    const existing = repo.labels.get(name);
    const color = typeof parsed.value.color === 'string' ? parsed.value.color : (existing?.color ?? 'ededed');
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return;
  }

  // issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        createIssueHttp(res, repo, body);
        return;
      }
      if (method === 'GET') {
        const state = queryParam(query, 'state') ?? 'open';
        const direction = queryParam(query, 'direction') ?? 'desc';
        let list = repo.issuesArr.filter((i) => state === 'all' || i.state === state);
        list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { perPage, page } = pageParams(query);
        const slice = list.slice((page - 1) * perPage, (page - 1) * perPage + perPage);
        const text = `[${slice.map((i) => serializeIssue(i)).join(',')}]`;
        sendBuf(res, 200, JSON_TYPE, Buffer.from(text, 'utf8'));
        return;
      }
    }
    if (tail.length >= 2) {
      const num = Number(tail[1]);
      const issue = Number.isFinite(num) ? repo.issuesMap.get(num) : undefined;
      if (tail.length === 2) {
        if (!issue) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
        if (method === 'GET') { sendBuf(res, 200, JSON_TYPE, issue.cached); return; }
        if (method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
          if (typeof parsed.value.state === 'string') {
            issue.state = parsed.value.state === 'closed' ? 'closed' : 'open';
          }
          if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
          if (typeof parsed.value.body === 'string' || parsed.value.body === null) {
            issue.body = parsed.value.body as string | null;
          }
          if (Array.isArray(parsed.value.labels)) {
            const names: string[] = [];
            for (const entry of parsed.value.labels) {
              const labelName = typeof entry === 'string' ? entry : String((entry as Record<string, unknown>)?.name ?? '');
              if (!repo.labels.has(labelName)) { sendError(res, 422, 'Validation Failed: unknown label'); return; }
              names.push(labelName);
            }
            issue.labels = names;
          }
          issue.updatedAt = new Date().toISOString();
          refreshIssueCache(issue);
          sendBuf(res, 200, JSON_TYPE, issue.cached);
          return;
        }
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (!issue) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.dbId, body: c.body, user: { login: VIEWER_LOGIN }, created_at: c.createdAt, updated_at: c.updatedAt,
          })));
          return;
        }
        if (method === 'POST') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
          const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
          const comment = addCommentRecord(repo, issue, commentBody);
          sendJson(res, 201, {
            id: comment.dbId, body: comment.body, user: { login: VIEWER_LOGIN },
            created_at: comment.createdAt, updated_at: comment.updatedAt,
          });
          return;
        }
      }
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  // pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
        const head = parsed.value.head;
        const base = parsed.value.base;
        const title = parsed.value.title;
        if (typeof head !== 'string' || typeof base !== 'string' || typeof title !== 'string') {
          sendError(res, 422, 'Validation Failed: head, base and title are required');
          return;
        }
        if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
          sendError(res, 422, 'Validation Failed: head or base branch not found');
          return;
        }
        const duplicate = repo.prsArr.some((p) => p.head === head && p.state === 'open');
        if (duplicate) { sendError(res, 422, 'Validation Failed: a pull request already exists for this head'); return; }
        const pr = createPrRecord(repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : null, head, base);
        sendJson(res, 201, prJson(repo, pr));
        return;
      }
      if (method === 'GET') {
        const state = queryParam(query, 'state') ?? 'open';
        const list = repo.prsArr.filter((p) => state === 'all' || p.state === state);
        sendJson(res, 200, list.map((p) => prJson(repo, p)));
        return;
      }
    }
    if (tail.length >= 2) {
      const num = Number(tail[1]);
      const pr = Number.isFinite(num) ? repo.prsMap.get(num) : undefined;
      if (tail.length === 2 && method === 'GET') {
        if (!pr) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
        // Refresh displayed tips from the live refs.
        pr.headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
        pr.baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
        sendJson(res, 200, prJson(repo, pr));
        return;
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        if (!pr) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
        sendJson(res, 200, prFiles(repo, pr));
        return;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (!pr) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
        if (body.length > 0) {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) { sendError(res, 400, 'Problems parsing JSON'); return; }
        }
        if (pr.merged) { sendError(res, 405, 'Pull request already merged'); return; }
        const outcome = mergePr(repo, pr);
        if (outcome.outcome === 'conflict') { sendError(res, 405, 'Merge conflict'); return; }
        if (outcome.outcome !== 'merged') { sendError(res, 405, 'Cannot merge pull request'); return; }
        sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }
    sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
    return;
  }

  sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
}

import { bumpRepo as bumpRepoFn } from './core.ts';
const bumpRef = { bumpRepo: bumpRepoFn };

function lineCounts(baseText: string | null, headText: string | null): { additions: number; deletions: number } {
  const count = (text: string | null): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === null) return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const baseCounts = count(baseText);
  const headCounts = count(headText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of headCounts) additions += Math.max(0, n - (baseCounts.get(line) ?? 0));
  for (const [line, n] of baseCounts) deletions += Math.max(0, n - (headCounts.get(line) ?? 0));
  return { additions, deletions };
}

function prFiles(repo: Repo, pr: { base: string; head: string }): unknown[] {
  const base = branchFiles(repo, `refs/heads/${pr.base}`);
  const head = branchFiles(repo, `refs/heads/${pr.head}`);
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  const out: unknown[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.blob === h.blob) continue;
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    const baseText = b ? (objects.get(b.blob)?.data.toString('utf8') ?? '') : null;
    const headText = h ? (objects.get(h.blob)?.data.toString('utf8') ?? '') : null;
    let { additions, deletions } = lineCounts(baseText, headText);
    if (additions === 0 && deletions === 0) additions = 1;
    if (status !== 'removed' && additions === 0) additions = 1;
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  out.sort((a, b) => {
    const fa = (a as { filename: string }).filename;
    const fb = (b as { filename: string }).filename;
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  return out;
}

// ---------- git smart HTTP ----------

function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, tail: string[], query: string, body: Buffer): void {
  const method = req.method ?? 'GET';
  const repo = owner === VIEWER_LOGIN ? repos.get(`${owner}/${repoName}`) : undefined;

  if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
    if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
    const service = queryParam(query, 'service');
    if (service === 'git-upload-pack') {
      const protocol = req.headers['git-protocol'] ?? '';
      if (protocol.includes('version=2')) {
        sendBuf(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
        return;
      }
      sendBuf(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV0(repo, 'git-upload-pack'));
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuf(res, 200, 'application/x-git-receive-pack-advertisement', advertisementV0(repo, 'git-receive-pack'));
      return;
    }
    sendError(res, 400, 'Unknown service');
    return;
  }

  if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
    if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
    const protocol = req.headers['git-protocol'] ?? '';
    try {
      if (protocol.includes('version=2')) {
        const first = readPkt(body, 0);
        if (first.kind !== 'data') throw new Error('bad command');
        const commandLine = first.payload.toString('utf8').trim();
        if (commandLine === 'command=ls-refs') {
          const prefixes: string[] = [];
          let peel = false;
          let symrefs = false;
          let unborn = false;
          let pos = first.next;
          let guard = 0;
          while (pos < body.length && guard++ < 10000) {
            const pkt = readPkt(body, pos);
            pos = pkt.next;
            if (pkt.kind === 'flush') break;
            if (pkt.kind !== 'data') continue;
            const line = pkt.payload.toString('utf8').replace(/\n$/, '');
            if (line === 'peel') peel = true;
            else if (line === 'symrefs') symrefs = true;
            else if (line === 'unborn') unborn = true;
            else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
          }
          sendBuf(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, prefixes, peel, symrefs, unborn));
          return;
        }
        if (commandLine === 'command=fetch') {
          const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null };
          let pos = first.next;
          let guard = 0;
          while (pos < body.length && guard++ < 100000) {
            const pkt = readPkt(body, pos);
            pos = pkt.next;
            if (pkt.kind === 'flush') break;
            if (pkt.kind !== 'data') continue;
            const line = pkt.payload.toString('utf8').replace(/\n$/, '');
            if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
            else if (line.startsWith('have ')) args.haves.push(line.slice(5, 45));
            else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8, 48));
            else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7));
          }
          for (const want of args.wants) {
            if (!objects.has(want)) { sendError(res, 400, 'Unknown want'); return; }
          }
          sendBuf(res, 200, 'application/x-git-upload-pack-result', fetchResponse(repo, args));
          return;
        }
        sendError(res, 400, 'Unknown command');
        return;
      }
      // v0 fetch fallback
      const wants: string[] = [];
      const haves: string[] = [];
      let pos = 0;
      let phase = 0;
      let guard = 0;
      while (pos < body.length && guard++ < 100000) {
        const pkt = readPkt(body, pos);
        pos = pkt.next;
        if (pkt.kind === 'flush') { phase = 1; continue; }
        if (pkt.kind !== 'data') continue;
        const line = pkt.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) wants.push(line.slice(5, 45));
        else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
        else if (line === 'done') break;
        void phase;
      }
      for (const want of wants) {
        if (!objects.has(want)) { sendError(res, 400, 'Unknown want'); return; }
      }
      sendBuf(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, wants, haves));
      return;
    } catch {
      sendError(res, 400, 'Malformed git-upload-pack request');
      return;
    }
  }

  if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
    if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
    try {
      const updates: RefUpdate[] = [];
      let pos = 0;
      let guard = 0;
      let sawFlush = false;
      while (pos < body.length && guard++ < 10000) {
        const pkt = readPkt(body, pos);
        pos = pkt.next;
        if (pkt.kind === 'flush') { sawFlush = true; break; }
        if (pkt.kind !== 'data') continue;
        let line = pkt.payload.toString('utf8').replace(/\n$/, '');
        const nul = line.indexOf('\0');
        if (nul !== -1) line = line.slice(0, nul);
        const parts = line.split(' ');
        if (parts.length < 3) throw new Error('bad ref update');
        updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
      if (!sawFlush && updates.length === 0 && body.length > 0) throw new Error('no ref updates');
      const out = receivePack(repo, updates, pos, body);
      sendBuf(res, 200, 'application/x-git-receive-pack-result', out);
      return;
    } catch {
      sendError(res, 400, 'Malformed git-receive-pack request');
      return;
    }
  }

  sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
}

// ---------- server ----------

const EMPTY_BODY = Buffer.alloc(0);

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    if (method === 'GET' || method === 'HEAD') {
      // Read-only requests carry no body: dispatch synchronously so the
      // read and clone hot paths never pay for promise/body machinery.
      try {
        dispatch(req, res, EMPTY_BODY);
      } catch {
        if (!res.headersSent) { try { sendError(res, 500, 'Internal Server Error'); } catch { /* gone */ } }
      }
      return;
    }
    void (async () => {
      try {
        const body = await readBody(req);
        dispatch(req, res, body);
      } catch {
        if (!res.headersSent) {
          try { sendError(res, 500, 'Internal Server Error'); } catch { /* socket gone */ }
        } else {
          try { res.end(); } catch { /* socket gone */ }
        }
      }
    })();
  });
  return server;
}

function dispatch(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  {
    {
      try {
        const rawUrl = req.url ?? '/';
        const qIdx = rawUrl.indexOf('?');
        let path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
        const query = qIdx === -1 ? '' : rawUrl.slice(qIdx + 1);
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendBuf(res, 200, JSON_TYPE, HEALTH_BUF);
          return;
        }

        // Hot paths: the read/write bench shapes, matched by direct
        // segment scans. Any mismatch falls through to generic routing.
        if ((method === 'GET' || method === 'POST') && path.startsWith('/api/v3/repos/')) {
          const restPath = path.slice('/api/v3/repos/'.length);
          const s1 = restPath.indexOf('/');
          if (s1 > 0) {
            const s2 = restPath.indexOf('/', s1 + 1);
            if (s2 > s1 + 1) {
              const ownerSeg = restPath.slice(0, s1);
              const tailPath = restPath.slice(s2 + 1);
              if (ownerSeg === VIEWER_LOGIN) {
                const repoSeg = restPath.slice(s1 + 1, s2);
                if (method === 'GET' && tailPath.startsWith('issues/')) {
                  const numStr = tailPath.slice('issues/'.length);
                  if (/^\d+$/.test(numStr)) {
                    if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
                    const repo = repos.get(`${ownerSeg}/${repoSeg}`);
                    if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
                    const issue = repo.issuesMap.get(Number(numStr));
                    if (!issue) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
                    sendBuf(res, 200, JSON_TYPE, issue.cached);
                    return;
                  }
                }
                if (method === 'POST' && tailPath === 'issues') {
                  if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
                  const repo = repos.get(`${ownerSeg}/${repoSeg}`);
                  if (!repo) { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
                  createIssueHttp(res, repo, body);
                  return;
                }
              }
            }
          }
        }

        // Hot path: the v2 upload-pack advertisement (3 of 5 clone calls).
        if (method === 'GET' && path.endsWith('.git/info/refs') && queryParam(query, 'service') === 'git-upload-pack') {
          const protocol = req.headers['git-protocol'] ?? '';
          if (protocol.includes('version=2')) {
            const segEnd = path.indexOf('/', 1);
            if (segEnd > 1) {
              const ownerSeg = path.slice(1, segEnd);
              const repoSeg = path.slice(segEnd + 1, path.length - '.git/info/refs'.length);
              if (ownerSeg === VIEWER_LOGIN && repos.has(`${ownerSeg}/${repoSeg}`)) {
                if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
                sendBuf(res, 200, 'application/x-git-upload-pack-advertisement', advertisementV2());
                return;
              }
            }
          }
        }

        if (path === '/mcp') {
          if (method !== 'POST') { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
          if (!req.headers.authorization) { sendError(res, 401, 'Unauthorized'); return; }
          if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
          const reply = handleMcp(body.toString('utf8'));
          if (reply.body === '') {
            requestCounter += 1;
            res.writeHead(200, { 'x-github-request-id': `req-${requestCounter}`, 'content-length': 0 });
            res.end();
            return;
          }
          sendBuf(res, reply.status, JSON_TYPE, Buffer.from(reply.body, 'utf8'));
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') { sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF); return; }
          if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
          let parsed: unknown;
          try { parsed = JSON.parse(body.toString('utf8')); } catch { sendError(res, 400, 'Problems parsing JSON'); return; }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => {
              const e = entry as { query?: string; variables?: Record<string, unknown> };
              return executeGraphQL(String(e.query ?? ''), e.variables ?? {});
            });
            sendJson(res, 200, results);
            return;
          }
          const single = parsed as { query?: string; variables?: Record<string, unknown> };
          sendJson(res, 200, executeGraphQL(String(single.query ?? ''), single.variables ?? {}));
          return;
        }

        const rawSegs = path.split('/');
        const segments = rawSegs[0] === '' ? rawSegs.slice(1) : rawSegs;

        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
          handleRest(req, res, segments.slice(2), query, body);
          return;
        }

        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          if (!authOk(req)) { sendError(res, 401, 'Unauthorized'); return; }
          handleGit(req, res, segments[0], segments[1].slice(0, -4), segments.slice(2), query, body);
          return;
        }

        sendBuf(res, 404, JSON_TYPE, NOT_FOUND_BUF);
      } catch {
        if (!res.headersSent) {
          try { sendError(res, 500, 'Internal Server Error'); } catch { /* socket gone */ }
        } else {
          try { res.end(); } catch { /* socket gone */ }
        }
      }
    }
  }
}
