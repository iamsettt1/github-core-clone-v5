// MCP endpoint: JSON-RPC 2.0 over Streamable HTTP with plain JSON
// answers. The tool list is one constant so tools/list is byte-identical
// across calls. Tool calls run against the same store as REST/GraphQL.

import { repos, createRepoRecord, VIEWER_LOGIN, type Repo } from './core.ts';
import { repoJson, createIssueRecord, createPrRecord, mergePr } from './store.ts';

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export interface McpReply {
  status: number;
  body: string; // '' means an empty body
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function findRepo(owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER_LOGIN) return null;
  return repos.get(`${owner}/${repo}`) ?? null;
}

function toolSuccess(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload, isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], structuredContent: { message }, isError: true };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (repos.has(`${VIEWER_LOGIN}/${repoName}`)) return toolFailure('Repository already exists');
      const repo = createRepoRecord(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return toolFailure('Repository not found');
      return toolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return toolFailure('Repository not found');
      const issue = createIssueRecord(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : null,
        [],
      );
      return toolSuccess({
        id: issue.dbId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      });
    }
    case 'list_issues': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return toolFailure('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = repo.issuesArr
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.dbId, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolSuccess({ issues });
    }
    case 'create_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return toolFailure('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return toolFailure('Head or base branch not found');
      }
      const pr = createPrRecord(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : null,
        head,
        base,
      );
      return toolSuccess({ id: pr.dbId, number: pr.number, title: pr.title, state: pr.state, head: pr.head, base: pr.base });
    }
    case 'merge_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      if (!repo) return toolFailure('Repository not found');
      const pr = repo.prsMap.get(Number(args.pull_number));
      if (!pr) return toolFailure('Pull request not found');
      if (pr.merged) return toolFailure('Pull request already merged');
      const outcome = mergePr(repo, pr);
      if (outcome.outcome === 'conflict') return toolFailure('Merge conflict');
      if (outcome.outcome !== 'merged') return toolFailure('Cannot merge pull request');
      return toolSuccess({ number: pr.number, merged: true, sha: outcome.sha, state: 'closed' });
    }
    default:
      return toolFailure(`Unknown tool: ${name}`);
  }
}

export function handleMcp(rawBody: string): McpReply {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    // Parse error: recover the id from the raw text when possible.
    let id: unknown = null;
    const m = /"id"\s*:\s*("([^"]*)"|-?\d+|null)/.exec(rawBody);
    if (m) id = m[2] !== undefined ? m[2] : (m[1] === 'null' ? null : Number(m[1]));
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const method = typeof msg.method === 'string' ? msg.method : '';
  const id = msg.id;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && id !== undefined;

  if (!hasId) {
    // A notification: acknowledged with an empty 200.
    return { status: 200, body: '' };
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      return rpcResult(id, callTool(toolName, args));
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
