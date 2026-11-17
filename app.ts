// The forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, over one
// in-memory store. Standard library only; the entrypoint (main.ts) owns the lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GraphQLExecutor } from './graphql.ts';
import {
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  pktLine,
  readPack,
  sidebandPack,
  writePack,
  ZERO_OID,
  PKT_FLUSH,
  type GitObject,
} from './gitproto.ts';
import { handleMcp, invalidateIssueJson, issueJson, issueJsonText, issueJsonTextLength, prJson, repoJson } from './mcp.ts';
import {
  FIXED_ISO,
  Store,
  VIEWER,
  peelToCommit,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-forge/1.0.0';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Write an already-serialized JSON body (with trailing newline) without re-stringifying or re-measuring it. */
function sendJsonText(res: ServerResponse, status: number, text: string, length: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message }, headers);
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return typeof header === 'string' && header.startsWith('Bearer ') && header.length > 7;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // Fast path: a small body on a keep-alive socket usually arrives with the headers, so
  // drain whatever is already buffered; when the message is complete that is the whole body.
  const chunks: Buffer[] = [];
  let total = 0;
  let chunk: Buffer | null;
  while ((chunk = req.read() as Buffer | null) !== null) {
    chunks.push(chunk);
    total += chunk.length;
  }
  if (req.complete) return Promise.resolve(Buffer.concat(chunks, total));
  return new Promise((resolve, reject) => {
    req.on('data', (piece: Buffer) => {
      chunks.push(piece);
      total += piece.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks, total)));
    req.on('error', reject);
  });
}

interface ParsedUrl {
  pathname: string;
  segments: string[];
  query: URLSearchParams;
}

/** Shared empty query params for the common no-query-string case. */
const EMPTY_PARAMS = new URLSearchParams();

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseUrl(req: IncomingMessage): ParsedUrl {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const rawPath = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? EMPTY_PARAMS : new URLSearchParams(raw.slice(q + 1));
  if (!rawPath.includes('%')) {
    // Fast path: nothing to percent-decode, so decodeSegment is the identity.
    return { pathname: rawPath, segments: rawPath.split('/').filter((segment) => segment !== ''), query };
  }
  const segments = rawPath
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
  return { pathname: rawPath, segments, query };
}

/** Parse a JSON request body; returns null and answers 400 when it is malformed. */
function parseJsonBody(res: ServerResponse, body: Buffer): Record<string, unknown> | null {
  if (body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
  return parsed as Record<string, unknown>;
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

/** A GitHub-style Link header for a paginated list, or null on the last page. */
function linkHeader(req: IncomingMessage, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (page >= pages) return null;
  const host = req.headers.host ?? '127.0.0.1';
  const base = new URL(req.url ?? '/', `http://${host}`);
  const make = (pageNumber: number): string => {
    const params = new URLSearchParams(base.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(pageNumber));
    return `<${base.origin}${base.pathname}?${params.toString()}>`;
  };
  const parts = [`${make(page + 1)}; rel="next"`, `${make(pages)}; rel="last"`, `${make(1)}; rel="first"`];
  if (page > 1) parts.push(`${make(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta multi_ack_detailed agent=${AGENT} symref=HEAD:refs/heads/main shallow`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      parts.push(pktLine(line));
      first = false;
      // Peeled tag lines, for annotated tags.
      const object = storeGlobal.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(storeGlobal, ref.oid);
        if (peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol-v2 advertisement is identical on every request: build it once. */
const V2_ADVERTISEMENT: Buffer = encodePktLines([
  'version 2\n',
  `agent=${AGENT}\n`,
  'ls-refs=unborn\n',
  'fetch=shallow wait-for-done filter\n',
  'server-option\n',
  'object-format=sha1\n',
  'flush',
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

// The store is module state so the git helpers below can read it without threading it
// through every call; createApp builds one store per server.
let storeGlobal: Store;

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  commonBase: string | null;
}

function planFetch(
  store: Store,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const included = new Map<string, GitObject>();
  const boundary: string[] = [];
  // Peel tag wants to their commits; keep the tag objects themselves in the pack.
  const wantCommits: string[] = [];
  for (const want of wants) {
    const object = store.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      included.set(want, object);
      const peeled = peelToCommit(store, want);
      if (peeled !== want) wantCommits.push(peeled);
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    } else {
      included.set(want, object);
    }
  }

  const visited = new Set<string>();
  const queue: Array<[string, number]> = wantCommits.map((oid) => [oid, 0] as [string, number]);
  while (queue.length) {
    const entry = queue.shift()!;
    const oid = entry[0];
    const dist = entry[1];
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    included.set(oid, object);
    const tree = store.treeOfCommit(oid);
    if (tree !== null) {
      for (const reachable of store.collectReachable([tree])) {
        const found = store.getObject(reachable);
        if (found !== undefined) included.set(reachable, found);
      }
    }
    const parents = store.parentsOf(oid);
    const canDescend = depth === null || dist + 1 < depth;
    if (!canDescend && parents.length > 0) boundary.push(oid);
    if (canDescend) {
      for (const parent of parents) queue.push([parent, dist + 1]);
    }
  }

  // What the client already holds, so it is not re-sent.
  const excluded = new Set<string>();
  let commonBase: string | null = null;
  if (depth !== null) {
    const boundaries = new Set(shallowBoundaries);
    for (const have of haves) {
      const seen = new Set<string>();
      const stack: string[] = [have];
      while (stack.length) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = store.getObject(oid);
        if (object === undefined) continue;
        if (object.type === 'commit') {
          excluded.add(oid);
          const tree = store.treeOfCommit(oid);
          if (tree !== null) {
            for (const reachable of store.collectReachable([tree])) excluded.add(reachable);
          }
          if (!boundaries.has(oid)) {
            for (const parent of store.parentsOf(oid)) stack.push(parent);
          }
        } else {
          for (const reachable of store.collectReachable([oid])) excluded.add(reachable);
        }
      }
    }
  } else {
    const wantClosure = store.collectReachable(wants);
    for (const have of haves) {
      if (!wantClosure.has(have)) continue;
      if (commonBase === null) commonBase = have;
      for (const reachable of store.collectReachable([have])) excluded.add(reachable);
    }
  }

  const objects: GitObject[] = [];
  for (const [oid, object] of included) {
    if (!excluded.has(oid)) objects.push(object);
  }
  const unshallow = shallowBoundaries.filter((oid) => visited.has(oid) && !boundary.includes(oid));
  return { objects, shallow: boundary, unshallow, commonBase };
}

/** One pkt-line payload as a string: cut at the NUL capability separator, strip the newline. */
function cleanLine(payload: Buffer): string {
  let text = payload.toString('utf8');
  const nul = text.indexOf('\0');
  if (nul >= 0) text = text.slice(0, nul);
  return text.replace(/\n$/, '');
}

function handleLsRefs(store: Store, repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => cleanLine(packet.payload));
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (repo.refs.size === 0) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  } else {
    if (keep('HEAD') && mainTip !== undefined) {
      parts.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
    for (const ref of sortedRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const object = store.getObject(ref.oid);
        if (object !== undefined && object.type === 'tag') {
          const peeled = peelToCommit(store, ref.oid);
          if (peeled !== ref.oid) line += ` peeled:${peeled}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchParams {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchParams(lines: readonly string[]): FetchParams {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowBoundaries: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0].trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isFinite(value) && value > 0) depth = Math.trunc(value);
    }
  }
  return { wants, haves, shallowBoundaries, depth };
}

/**
 * Fetch responses are pure functions of (wants, haves, shallow, depth): objects are
 * immutable and content-addressed, so a fetch can never change once computed. Cache the
 * assembled response; the clone workload issues 50 identical depth-1 fetches, so this
 * turns 50 pack builds into one. Bounded and FIFO-evicted.
 */
const fetchCache = new Map<string, Buffer>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(protocol: 'v2' | 'v0', params: FetchParams): string {
  return `${protocol}|${params.wants.join(',')}|${params.haves.join(',')}|${params.shallowBoundaries.join(',')}|${params.depth ?? ''}`;
}

function fetchCacheSet(key: string, value: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, value);
}

function handleFetchV2(store: Store, repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => cleanLine(packet.payload));
  const params = parseFetchParams(lines);
  const key = fetchCacheKey('v2', params);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(store, params.wants, params.haves, params.shallowBoundaries, params.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.commonBase !== null) {
    parts.push(pktLine(`ACK ${plan.commonBase}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_FLUSH);
  if (params.depth !== null || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  fetchCacheSet(key, out);
  return out;
}

function handleFetchV0(store: Store, repo: Repo, packets: readonly { kind: string; payload: Buffer }[]): Buffer {
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => cleanLine(packet.payload));
  const params = parseFetchParams(lines);
  const key = fetchCacheKey('v0', params);
  const cached = fetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(store, params.wants, params.haves, params.shallowBoundaries, params.depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.commonBase !== null) parts.push(pktLine(`ACK ${plan.commonBase}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  fetchCacheSet(key, out);
  return out;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const contentType = 'application/x-git-receive-pack-result';
  // Parse the pkt-lined command list; the pack follows the flush packet raw.
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let malformed = false;
  try {
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) {
        malformed = true;
        break;
      }
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > body.length) {
        malformed = true;
        break;
      }
      const payload = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      const line = payload.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const text = nul >= 0 ? line.slice(0, nul) : line;
      if (nul >= 0 && commands.length === 0) {
        capabilities = line.slice(nul + 1).split(' ').filter((token) => token !== '');
      }
      const parts = text.split(' ');
      if (parts.length !== 3 || !isObjectId(parts[0]) || !isObjectId(parts[1]) || !parts[2].startsWith('refs/')) {
        malformed = true;
        break;
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  } catch {
    malformed = true;
  }
  if (malformed || commands.length === 0) {
    return { status: 400, body: Buffer.from(JSON.stringify({ message: 'malformed receive-pack request' }), 'utf8'), contentType: JSON_TYPE };
  }

  // The pack, when one follows the command list.
  let unpackError: string | null = null;
  if (offset < body.length) {
    try {
      const objects = readPack(body.subarray(offset), (oid) => store.getObject(oid));
      for (const [oid, object] of objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | null = null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reason = 'cannot delete a ref that does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) reason = 'already exists';
        else if (store.getObject(command.newOid) === undefined) reason = 'missing object';
      } else {
        // Update.
        if (current === undefined) reason = 'non-fast-forward';
        else if (command.oldOid !== current) reason = 'non-fast-forward';
        else if (!store.isAncestor(current, command.newOid)) reason = 'non-fast-forward';
        else if (store.getObject(command.newOid) === undefined) reason = 'missing object';
      }
      if (reason !== null) {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      } else {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }

  const report = encodePktLines([...reportLines.map((line) => line as string), 'flush']);
  const sideband = capabilities.includes('side-band-64k');
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (let at = 0; at < report.length; at += 65500) {
      const chunk = report.subarray(at, Math.min(report.length, at + 65500));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = report;
  }
  return { status: 200, body: out, contentType };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function viewerJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: Store.globalId('User', [VIEWER.id]),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function commitJson(store: Store, sha: string): Record<string, unknown> {
  const object = store.getObject(sha);
  let message = '';
  let treeSha = ZERO_OID;
  if (object !== undefined && object.type === 'commit') {
    // parseCommit returns the raw body, including the trailing newline makeCommit adds.
    // commitView returns null only for a malformed commit; re-parse then, as before,
    // so a malformed commit still throws instead of silently reporting an empty tree.
    const view = store.commitView(sha) ?? parseCommit(object.data);
    message = view.message.replace(/\n+$/, '');
    treeSha = view.tree;
  }
  return {
    sha,
    node_id: Store.globalId('Commit', [sha]),
    commit: {
      message,
      author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
      committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
      tree: { sha: treeSha },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    url: `/api/v3/commits/${sha}`,
    html_url: `/commit/${sha}`,
  };
}

function repoView(repo: Repo): Record<string, unknown> {
  const view = repoJson(repo);
  view.has_projects = false;
  view.has_wiki = false;
  view.has_pages = false;
  view.has_downloads = true;
  view.archived = false;
  view.disabled = false;
  view.open_issues_count = repo.issueOrder.filter((number) => repo.issues.get(number)?.state === 'open').length;
  view.license = null;
  view.forks = 0;
  view.open_issues = view.open_issues_count;
  view.watchers = 0;
  view.default_branch = repo.defaultBranch;
  return view;
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '', default: true };
}

function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Store.globalId('IssueComment', [repo.dbId, issueNumber, comment.id]),
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `/${VIEWER.login}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

/** Line counts for a PR file diff, from the two blob versions. */
function lineCounts(store: Store, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (oid === null) return [];
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'blob') return [];
    const text = object.data.toString('utf8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  let additions = 0;
  for (const line of newLines) if (!oldSet.has(line)) additions += 1;
  let deletions = 0;
  for (const line of oldLines) if (!newSet.has(line)) deletions += 1;
  return { additions, deletions };
}

function filesJson(store: Store, repo: Repo, pr: PullRequest): Array<Record<string, unknown>> {
  const files = store.prFiles(repo, pr);
  return files.map((file) => {
    const { additions, deletions } = lineCounts(store, file.oldOid, file.newOid);
    const sha = file.newOid ?? file.oldOid ?? ZERO_OID;
    return {
      sha,
      filename: file.path,
      status: file.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `/${VIEWER.login}/${repo.name}/blob/${pr.headSha}/${file.path}`,
      raw_url: `/${VIEWER.login}/${repo.name}/raw/${pr.headSha}/${file.path}`,
      contents_url: `/api/v3/repos/${VIEWER.login}/${repo.name}/contents/${file.path}?ref=${pr.head}`,
    };
  });
}

/** Resolve /repos/{owner}/{name}: 404 unless the owner is the token's login and the repo exists. */
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(name) ?? null;
}

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  parsed: ParsedUrl,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = parsed.segments;
  const query = parsed.query;

  // GET /api/v3/ — root.
  if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'v3') {
    if (method !== 'GET') return sendError(res, 404, 'Not Found');
    return sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      meta: { verifiable_password_authentication: true },
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg.length < 3 || seg[0] !== 'api' || seg[1] !== 'v3') {
    return sendError(res, 404, 'Not Found');
  }
  const rest = seg[2];

  if (rest === 'meta' && method === 'GET') {
    return sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, git: ['1.0.0'] });
  }

  if (rest === 'user' && method === 'GET' && seg.length === 3) {
    return sendJson(res, 200, viewerJson());
  }

  if (rest === 'user' && seg.length === 4 && seg[3] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const all = [...store.repos.values()];
      const total = all.length;
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const link = linkHeader(req, query, perPage, page, total);
      return sendJson(res, 200, slice.map((repo) => repoView(repo)), link !== null ? { link } : {});
    }
    if (method === 'POST') {
      const input = parseJsonBody(res, body);
      if (input === null) return;
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
      const description = typeof input.description === 'string' ? input.description : '';
      const isPrivate = input.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) return sendError(res, 422, 'Repository already exists');
      return sendJson(res, 201, repoView(repo));
    }
    return sendError(res, 404, 'Not Found');
  }

  if (rest === 'repos') {
    // /repos/{owner}/{repo}[/...]
    if (seg.length < 5) return sendError(res, 404, 'Not Found');
    const owner = seg[3];
    const repoName = seg[4];
    const repo = resolveRepo(store, owner, repoName);
    const tail = seg.slice(5);

    if (tail.length === 0) {
      if (method === 'GET') {
        if (repo === null) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, repoView(repo));
      }
      if (method === 'PATCH') {
        if (repo === null) return sendError(res, 404, 'Not Found');
        const input = parseJsonBody(res, body);
        if (input === null) return;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.name === 'string' && input.name !== '' && input.name !== repo.name) {
          // Renaming is not part of the suite; keep the original name.
        }
        if (input.default_branch !== undefined && typeof input.default_branch === 'string') {
          repo.defaultBranch = input.default_branch;
        }
        return sendJson(res, 200, repoView(repo));
      }
      if (method === 'DELETE') {
        if (repo === null) return sendError(res, 404, 'Not Found');
        store.deleteRepo(repo.name);
        return sendJson(res, 204, null);
      }
      return sendError(res, 404, 'Not Found');
    }

    if (repo === null) return sendError(res, 404, 'Not Found');

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((ref) => ref.startsWith('refs/heads/'))
          .map((ref) => ref.slice('refs/heads/'.length))
          .sort()
          .map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID}` },
          protected: false,
        }));
        return sendJson(res, 200, branches);
      }
      if (tail.length === 2 && method === 'GET') {
        const tip = repo.refs.get(`refs/heads/${tail[1]}`);
        if (tip === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, {
          name: tail[1],
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` },
          protected: false,
        });
      }
      return sendError(res, 404, 'Not Found');
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const refName = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, refName);
      if (tip === null) return sendJson(res, 200, []);
      const shas = store.walkCommits(tip);
      return sendJson(res, 200, shas.map((sha) => commitJson(store, sha)));
    }

    if (tail[0] === 'git' && tail[1] === 'refs' && method === 'POST' && tail.length === 2) {
      const input = parseJsonBody(res, body);
      if (input === null) return;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha)) return sendError(res, 422, 'Validation Failed: ref and sha are required');
      repo.refs.set(ref, sha);
      const object = store.getObject(sha);
      return sendJson(res, 201, {
        ref,
        node_id: Store.globalId('Ref', [repo.dbId, ref]),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`,
        object: { sha, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/${object?.type ?? 'commit'}s/${sha}` },
      });
    }
    if (tail[0] === 'git' && tail[1] === 'refs' && tail.length >= 4 && method === 'GET') {
      const refName = tail.slice(2).join('/');
      const ref = `refs/${refName}`;
      const tip = repo.refs.get(ref);
      if (tip === undefined) return sendError(res, 404, 'Not Found');
      const object = store.getObject(tip);
      return sendJson(res, 200, {
        ref,
        node_id: Store.globalId('Ref', [repo.dbId, ref]),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${refName}`,
        object: { sha: tip, type: object?.type ?? 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/${object?.type ?? 'commit'}s/${tip}` },
      });
    }

    if (tail[0] === 'contents' && tail.length >= 2) {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = store.resolveRef(repo, ref ?? repo.defaultBranch);
        const tree = tip === null ? null : store.treeOfCommit(tip);
        if (tree === null) return sendError(res, 404, 'Not Found');
        const entry = store.entryAt(tree, path);
        if (entry === null) {
          const dirEntries = store.listDir(tree, path);
          if (dirEntries === null) return sendError(res, 404, 'Not Found');
          return sendJson(res, 200, dirEntries.map((child) => {
            const isDir = child.mode === '40000';
            const childPath = path === '' ? child.name : `${path}/${child.name}`;
            return {
              type: isDir ? 'dir' : 'file',
              size: 0,
              name: child.name,
              path: childPath,
              sha: child.oid,
              url: `/api/v3/repos/${owner}/${repoName}/contents/${childPath}`,
              html_url: `/${owner}/${repoName}/${isDir ? 'tree' : 'blob'}/${ref ?? repo.defaultBranch}/${childPath}`,
              git_url: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${child.oid}`,
              download_url: null,
            };
          }));
        }
        if (entry.mode === '40000') {
          const dirEntries = store.listDir(tree, path) ?? [];
          return sendJson(res, 200, dirEntries.map((child) => {
            const isDir = child.mode === '40000';
            const childPath = `${path}/${child.name}`;
            return {
              type: isDir ? 'dir' : 'file',
              size: 0,
              name: child.name,
              path: childPath,
              sha: child.oid,
              url: `/api/v3/repos/${owner}/${repoName}/contents/${childPath}`,
              html_url: `/${owner}/${repoName}/${isDir ? 'tree' : 'blob'}/${ref ?? repo.defaultBranch}/${childPath}`,
              git_url: `/api/v3/repos/${owner}/${repoName}/git/${isDir ? 'trees' : 'blobs'}/${child.oid}`,
              download_url: null,
            };
          }));
        }
        const object = store.getObject(entry.oid)!;
        const content = object.data.toString('base64');
        return sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: path.split('/').pop() ?? path,
          path,
          content,
          sha: entry.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `/${owner}/${repoName}/blob/${ref ?? repo.defaultBranch}/${path}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${entry.oid}`,
          download_url: null,
        });
      }
      if (method === 'PUT') {
        const input = parseJsonBody(res, body);
        if (input === null) return;
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const content = typeof input.content === 'string' ? input.content : '';
        const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        // Stale-sha guard: the store commits unconditionally, so check first.
        if (sha !== undefined) {
          const tip = store.resolveRef(repo, branch);
          const tree = tip === null ? null : store.treeOfCommit(tip);
          const current = tree === null ? null : store.entryAt(tree, path);
          if (current === null || current.oid !== sha) {
            return sendError(res, 409, 'Conflict: the file has changed since you last read it');
          }
        }
        const contentBytes = Buffer.from(content, 'base64');
        const result = store.commitFile(repo, branch, path, contentBytes, message);
        return sendJson(res, result.created ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: result.blobSha,
            size: contentBytes.length,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
            html_url: `/${owner}/${repoName}/blob/${branch}/${path}`,
            git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${result.blobSha}`,
            type: 'file',
            content,
            encoding: 'base64',
          },
          commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO }, committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO } },
        });
      }
      if (method === 'DELETE') {
        const input = parseJsonBody(res, body);
        if (input === null) return;
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const sha = typeof input.sha === 'string' ? input.sha : '';
        const tip = store.resolveRef(repo, repo.defaultBranch);
        const tree = tip === null ? null : store.treeOfCommit(tip);
        const current = tree === null ? null : store.entryAt(tree, path);
        if (current === null) return sendError(res, 404, 'Not Found');
        if (sha !== '' && current.oid !== sha) {
          return sendError(res, 409, 'Conflict: the file has changed since you last read it');
        }
        const result = store.deleteFile(repo, repo.defaultBranch, path, message);
        if (result === null) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, {
          commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO }, committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO } },
        });
      }
      return sendError(res, 404, 'Not Found');
    }

    if (tail[0] === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        return sendJson(res, 200, [...repo.labels.values()].map((label) => labelJson(label)));
      }
      if (tail.length === 1 && method === 'POST') {
        const input = parseJsonBody(res, body);
        if (input === null) return;
        const name = typeof input.name === 'string' ? input.name : '';
        const color = typeof input.color === 'string' ? input.color : 'ededed';
        if (name === '') return sendError(res, 422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return sendJson(res, 200, labelJson(existing));
        const label = { name, color };
        repo.labels.set(name, label);
        return sendJson(res, 201, labelJson(label));
      }
      return sendError(res, 404, 'Not Found');
    }

    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = (query.get('sort') ?? 'created').toLowerCase();
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          const { perPage, page } = pageParams(query);
          let list = repo.issueOrder.map((number) => repo.issues.get(number)!);
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list = [...list].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const total = list.length;
          const slice = list.slice((page - 1) * perPage, page * perPage);
          const link = linkHeader(req, query, perPage, page, total);
          return sendJson(res, 200, slice.map((issue) => issueJson(repo, issue)), link !== null ? { link } : {});
        }
        if (method === 'POST') {
          const input = parseJsonBody(res, body);
          if (input === null) return;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') return sendError(res, 422, 'Validation Failed: title is required');
          const bodyText = typeof input.body === 'string' ? input.body : '';
          const labelNames = Array.isArray(input.labels) ? input.labels.map((item) => String(item)) : [];
          const labels: { name: string; color: string }[] = [];
          for (const labelName of labelNames) {
            const found = repo.labels.get(labelName);
            if (found === undefined) return sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
            labels.push(found);
          }
          const issue = store.createIssue(repo, title, bodyText, labels);
          return sendJsonText(res, 201, issueJsonText(repo, issue), issueJsonTextLength(repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      const issueNumber = Number(tail[1]);
      if (!Number.isInteger(issueNumber)) return sendError(res, 404, 'Not Found');
      if (tail.length === 2) {
        if (method === 'GET') {
          const issue = repo.issues.get(issueNumber);
          if (issue === undefined) return sendError(res, 404, 'Not Found');
          return sendJsonText(res, 200, issueJsonText(repo, issue), issueJsonTextLength(repo, issue));
        }
        if (method === 'PATCH') {
          const issue = repo.issues.get(issueNumber);
          if (issue === undefined) return sendError(res, 404, 'Not Found');
          const input = parseJsonBody(res, body);
          if (input === null) return;
          if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) issue.state = input.state;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          invalidateIssueJson(issue);
          return sendJsonText(res, 200, issueJsonText(repo, issue), issueJsonTextLength(repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          const comments = repo.comments.get(issueNumber) ?? [];
          return sendJson(res, 200, comments.map((comment) => commentJson(repo, issueNumber, comment)));
        }
        if (method === 'POST') {
          const issue = repo.issues.get(issueNumber);
          if (issue === undefined) return sendError(res, 404, 'Not Found');
          const input = parseJsonBody(res, body);
          if (input === null) return;
          const commentBody = typeof input.body === 'string' ? input.body : '';
          const comment = store.createComment(repo, issueNumber, commentBody);
          if (comment === null) return sendError(res, 404, 'Not Found');
          return sendJson(res, 201, commentJson(repo, issueNumber, comment));
        }
        return sendError(res, 404, 'Not Found');
      }
      return sendError(res, 404, 'Not Found');
    }

    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const { perPage, page } = pageParams(query);
          let list = repo.prOrder.map((number) => repo.prs.get(number)!);
          if (state !== 'all') list = list.filter((pr) => pr.state === state);
          const total = list.length;
          const slice = list.slice((page - 1) * perPage, page * perPage);
          const link = linkHeader(req, query, perPage, page, total);
          return sendJson(res, 200, slice.map((pr) => prJson(repo, pr)), link !== null ? { link } : {});
        }
        if (method === 'POST') {
          const input = parseJsonBody(res, body);
          if (input === null) return;
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
          if (title === '' || head === '') return sendError(res, 422, 'Validation Failed: title and head are required');
          const bodyText = typeof input.body === 'string' ? input.body : '';
          const pr = store.createPullRequest(repo, title, bodyText, head, base);
          if (pr === null) return sendError(res, 422, 'Validation Failed: the head or base branch does not exist');
          return sendJson(res, 201, prJson(repo, pr));
        }
        return sendError(res, 404, 'Not Found');
      }
      const prNumber = Number(tail[1]);
      if (!Number.isInteger(prNumber)) return sendError(res, 404, 'Not Found');
      if (tail.length === 2 && method === 'GET') {
        const pr = repo.prs.get(prNumber);
        if (pr === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, prJson(repo, pr));
      }
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const pr = repo.prs.get(prNumber);
        if (pr === undefined) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, filesJson(store, repo, pr));
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const pr = repo.prs.get(prNumber);
        if (pr === undefined) return sendError(res, 404, 'Not Found');
        if (pr.state === 'closed') return sendError(res, 405, 'Method Not Allowed: pull request is already closed');
        if (store.prConflicts(repo, pr)) return sendError(res, 405, 'Merge conflict: this pull request cannot be merged');
        const result = store.mergePullRequest(repo, pr);
        if (result === null) return sendError(res, 405, 'Method Not Allowed: pull request cannot be merged');
        if ('conflict' in result) return sendError(res, 405, 'Merge conflict: this pull request cannot be merged');
        return sendJson(res, 200, {
          sha: result.sha,
          merged: true,
          message: `Merge pull request #${prNumber} from ${VIEWER.login}/${pr.head}`,
        });
      }
      return sendError(res, 404, 'Not Found');
    }

    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git dispatch
// ---------------------------------------------------------------------------

async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  parsed: ParsedUrl,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const seg = parsed.segments;
  // /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
  if (seg.length < 2 || !seg[1].endsWith('.git')) {
    return sendError(res, 404, 'Not Found');
  }
  const owner = seg[0];
  const repoName = seg[1].slice(0, -4);
  const service = seg[2] ?? '';
  const repo = resolveRepo(store, owner, repoName);
  if (repo === null) {
    return sendError(res, 404, 'Not Found');
  }

  if (method === 'GET' && service === 'info' && seg[3] === 'refs') {
    const requested = parsed.query.get('service') ?? '';
    if (requested === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (v2) return sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return sendBytes(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    }
    if (requested === 'git-receive-pack') {
      return sendBytes(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
    }
    return sendError(res, 400, 'unknown service');
  }

  if (method === 'POST' && service === 'git-upload-pack') {
    let packets;
    try {
      packets = decodePktLines(body);
    } catch {
      return sendError(res, 400, 'malformed pkt-line stream');
    }
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2'
      || (packets.length > 0 && packets[0].kind === 'data' && packets[0].payload.toString('utf8').startsWith('command='));
    if (isV2) {
      const first = packets.length > 0 && packets[0].kind === 'data' ? cleanLine(packets[0].payload) : '';
      if (first === 'command=ls-refs') {
        return sendBytes(res, 200, handleLsRefs(store, repo, packets), 'application/x-git-upload-pack-result');
      }
      if (first === 'command=fetch') {
        return sendBytes(res, 200, handleFetchV2(store, repo, packets), 'application/x-git-upload-pack-result');
      }
      return sendError(res, 400, 'unknown v2 command');
    }
    return sendBytes(res, 200, handleFetchV0(store, repo, packets), 'application/x-git-upload-pack-result');
  }

  if (method === 'POST' && service === 'git-receive-pack') {
    const result = handleReceivePack(store, repo, body);
    return sendBytes(res, result.status, result.body, result.contentType);
  }

  return sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  const store = new Store();
  storeGlobal = store;
  const graphql = new GraphQLExecutor(store);

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const parsed = parseUrl(req);
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (parsed.pathname === '/healthz') {
          if (method === 'GET') return sendJson(res, 200, { ok: true });
          return sendError(res, 404, 'Not Found');
        }

        const seg = parsed.segments;

        // MCP.
        if (seg.length === 1 && seg[0] === 'mcp') {
          if (method !== 'POST') return sendError(res, 404, 'Not Found');
          if (!isAuthorized(req)) return sendError(res, 401, 'Bad credentials');
          const handled = handleMcp(store, body);
          if (handled.body === '') {
            res.writeHead(handled.status, { 'x-github-request-id': nextRequestId() });
            return res.end();
          }
          return sendBytes(res, handled.status, Buffer.from(handled.body, 'utf8'), 'application/json; charset=utf-8');
        }

        // GraphQL.
        if (seg.length === 2 && seg[0] === 'api' && seg[1] === 'graphql') {
          if (method !== 'POST') return sendError(res, 404, 'Not Found');
          if (!isAuthorized(req)) return sendError(res, 401, 'Bad credentials');
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(body.toString('utf8'));
          } catch {
            return sendError(res, 400, 'Problems parsing JSON');
          }
          const answer = graphql.executeBody(parsedBody);
          return sendJson(res, 200, answer);
        }

        // REST v3.
        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          if (!isAuthorized(req)) return sendError(res, 401, 'Bad credentials');
          return handleRest(store, req, res, parsed, body);
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (seg.length >= 2 && seg[1].endsWith('.git')) {
          return handleGit(store, req, res, parsed, body);
        }

        return sendError(res, 404, 'Not Found');
      } catch (err) {
        // Never crash the server on a bad request.
        try {
          sendError(res, 500, 'Internal Server Error');
        } catch {
          // The socket is already gone.
        }
      }
    })();
  });

  return server;
}

export default createApp;
