// MCP (Model Context Protocol) over Streamable HTTP, modern revision 2026-07-28:
// server/discover, tools/list and tools/call over the same store REST uses.
// A legacy initialize handshake is answered too, so a pre-discover client still connects.

import { Store, VIEWER, FIXED_ISO, type Repo } from './store.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
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
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
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
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'github-core-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

/** The tools/list answer, byte-identical on every call (one frozen object). */
const TOOLS_RESULT = Object.freeze({ tools: TOOLS });

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: Store.globalId('Repository', [repo.dbId]),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${VIEWER.login}/${repo.name}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
  };
}

export function issueJson(repo: Repo, issue: { id: number; number: number; title: string; body: string; state: string; labels: { name: string; color: string }[] }): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Store.globalId('Issue', [repo.dbId, issue.number]),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null,
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
  };
}

export function prJson(repo: Repo, pr: {
  id: number; number: number; title: string; body: string; state: string; merged: boolean;
  mergedAt: string | null; mergeSha: string | null; head: string; base: string; headSha: string; baseSha: string;
}): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
  return {
    id: pr.id,
    node_id: Store.globalId('PullRequest', [repo.dbId, pr.number]),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    draft: false,
    head: { label: `${VIEWER.login}:${pr.head}`, ref: pr.head, sha: headSha },
    base: { label: `${VIEWER.login}:${pr.base}`, ref: pr.base, sha: baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeSha,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pr.state === 'closed' ? FIXED_ISO : null,
    html_url: `/${VIEWER.login}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pr.number}`,
  };
}

interface ToolOutcome {
  /** A tool result object (content + structuredContent), or null when the call is a JSON-RPC error. */
  result: Record<string, unknown> | null;
  /** A JSON-RPC error to answer instead of a result. */
  rpcError: { code: number; message: string } | null;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoFor(args: Record<string, unknown>, store: Store): Repo | null {
  const owner = args.owner;
  const repoName = args.repo;
  if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(repoName) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { result: null, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return { result: null, rpcError: { code: -32602, message: `Invalid params: missing required argument "${required}" for tool "${name}"` } };
    }
  }

  if (name === 'create_repo') {
    const repoName = args.name as string;
    const description = typeof args.description === 'string' ? args.description : '';
    const isPrivate = args.private === true;
    const repo = store.createRepo(repoName, description, isPrivate);
    if (repo === null) return { result: toolErrorResult(`Repository already exists: ${VIEWER.login}/${repoName}`), rpcError: null };
    return { result: toolResult(repoJson(repo)), rpcError: null };
  }

  if (name === 'get_repo') {
    const repo = repoFor(args, store);
    if (repo === null) return { result: toolErrorResult('Not Found'), rpcError: null };
    return { result: toolResult(repoJson(repo)), rpcError: null };
  }

  if (name === 'create_issue') {
    const repo = repoFor(args, store);
    if (repo === null) return { result: toolErrorResult('Not Found'), rpcError: null };
    const title = args.title as string;
    const body = typeof args.body === 'string' ? args.body : '';
    const issue = store.createIssue(repo, title, body, []);
    return { result: toolResult(issueJson(repo, issue)), rpcError: null };
  }

  if (name === 'list_issues') {
    const repo = repoFor(args, store);
    if (repo === null) return { result: toolErrorResult('Not Found'), rpcError: null };
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list: Record<string, unknown>[] = [];
    for (const number of repo.issueOrder) {
      const issue = repo.issues.get(number)!;
      if (state === 'all' || issue.state === state) list.push(issueJson(repo, issue));
    }
    return { result: toolResult(list), rpcError: null };
  }

  if (name === 'create_pull_request') {
    const repo = repoFor(args, store);
    if (repo === null) return { result: toolErrorResult('Not Found'), rpcError: null };
    const title = args.title as string;
    const body = typeof args.body === 'string' ? args.body : '';
    const head = args.head as string;
    const base = args.base as string;
    const pr = store.createPullRequest(repo, title, body, head, base);
    if (pr === null) return { result: toolErrorResult('Cannot create pull request: the head or base branch does not exist.'), rpcError: null };
    return { result: toolResult(prJson(repo, pr)), rpcError: null };
  }

  if (name === 'merge_pull_request') {
    const repo = repoFor(args, store);
    if (repo === null) return { result: toolErrorResult('Not Found'), rpcError: null };
    const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    const pr = repo.prs.get(number);
    if (pr === undefined) return { result: toolErrorResult(`Pull request #${number} does not exist.`), rpcError: null };
    const result = store.mergePullRequest(repo, pr);
    if (result === null) return { result: toolErrorResult(`Pull request #${number} cannot be merged: it is already closed.`), rpcError: null };
    if ('conflict' in result) return { result: toolErrorResult(`Pull request #${number} has merge conflicts.`), rpcError: null };
    return { result: toolResult({ merged: true, sha: result.sha, message: `Merge pull request #${number} from ${VIEWER.login}/${pr.head}`, number: pr.number }), rpcError: null };
  }

  return { result: null, rpcError: { code: -32602, message: `Unknown tool: ${name}` } };
}

export interface McpHandling {
  status: number;
  body: string;
}

/**
 * Handle one POST /mcp body (already read). Returns the HTTP status and the exact body to send.
 * Auth is checked by the caller before this runs.
 */
export function handleMcp(store: Store, rawBody: Buffer): McpHandling {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: request body is not valid JSON' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } }),
    };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id === undefined ? null : (request.id as string | number | null);
  const method = typeof request.method === 'string' ? request.method : '';

  const errorResponse = (status: number, code: number, message: string): McpHandling => ({
    status,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  // A notification (no id) is acknowledged with 202 and no body.
  if (request.id === undefined) {
    return { status: 202, body: '' };
  }

  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        },
      }),
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      }),
    };
  }

  if (method === 'ping') {
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: {} }) };
  }

  if (method === 'tools/list') {
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: TOOLS_RESULT }) };
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return errorResponse(200, -32602, 'Invalid params: arguments must be an object');
    }
    const outcome = callTool(store, name, args);
    if (outcome.rpcError !== null) {
      return errorResponse(200, outcome.rpcError.code, outcome.rpcError.message);
    }
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result: outcome.result }) };
  }

  return errorResponse(200, -32601, `Method not found: ${method}`);
}
