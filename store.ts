// The forge's in-memory store: repositories, git objects, refs, issues, pull requests,
// labels and comments. Everything is deterministic: no wall clock, no randomness —
// commit timestamps come from one fixed epoch, ids from counters, in creation order.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitproto.ts';

/** The token owner's identity, from the kit's fixed scenario (wire.ts buildScenario). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const VIEWER_IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** One fixed epoch for every commit this forge writes (deterministic across runs). */
export const FIXED_EPOCH_SEC = 1_700_000_000;

/** Fixed ISO timestamps for REST/GraphQL date fields (deterministic across runs). */
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Repo {
  name: string;
  dbId: number;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  issueOrder: number[];
  prs: Map<number, PullRequest>;
  prOrder: number[];
  labels: Map<string, Label>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  createdSeq: number;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextNodeId = 100000;
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextId(): number {
    this.nextNodeId += 1;
    return this.nextNodeId;
  }

  // ------------------------------------------------------------------ objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putBlob(data: Buffer): string {
    return this.putObject('blob', data);
  }

  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp: FIXED_EPOCH_SEC,
    });
    return this.putObject('commit', data);
  }

  /** The commit a ref points at, or null. */
  commitOf(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Resolve a ref name (branch, full ref, or oid) to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (isObjectId(ref)) return this.objects.has(ref) ? ref : null;
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const full = `refs/heads/${ref}`;
    if (repo.refs.has(full)) return repo.refs.get(full)!;
    return null;
  }

  /** The tree oid of a commit, or null. */
  treeOfCommit(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    try {
      return parseCommit(object.data).tree;
    } catch {
      return null;
    }
  }

  /** The parents of a commit, or []. */
  parentsOf(commitOid: string): string[] {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return [];
    try {
      return parseCommit(object.data).parents;
    } catch {
      return [];
    }
  }

  /** True when `ancestor` is `descendant` or reachable from it through parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of this.parentsOf(oid)) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** Every object reachable from `roots` (commits, tags, trees, blobs). */
  collectReachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root)) queue.push(root);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        try {
          const commit = parseCommit(object.data);
          queue.push(commit.tree);
          for (const parent of commit.parents) queue.push(parent);
        } catch {
          // ignore a malformed commit
        }
      } else if (object.type === 'tag') {
        try {
          queue.push(parseTag(object.data).object);
        } catch {
          // ignore
        }
      } else if (object.type === 'tree') {
        try {
          for (const entry of parseTree(object.data)) {
            if (entry.mode !== '160000') queue.push(entry.oid);
          }
        } catch {
          // ignore
        }
      }
    }
    return seen;
  }

  /** Walk a commit chain newest-first (tip, then parents, breadth-first, deduped). */
  walkCommits(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of this.parentsOf(oid)) queue.push(parent);
    }
    return out;
  }

  // ------------------------------------------------------------------ trees

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null), based on `baseTreeOid`
   * (null for an empty tree). Intermediate trees are created as needed.
   */
  updateTree(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) throw new Error('empty path');
    const build = (treeOid: string | null, depth: number): string => {
      const entries: TreeEntry[] = [];
      if (treeOid !== null) {
        const object = this.objects.get(treeOid);
        if (object && object.type === 'tree') {
          try {
            for (const entry of parseTree(object.data)) entries.push(entry);
          } catch {
            // treat a malformed tree as empty
          }
        }
      }
      const name = segments[depth];
      const last = depth === segments.length - 1;
      const at = entries.findIndex((entry) => entry.name === name);
      if (last) {
        if (blobOid === null) {
          if (at >= 0) entries.splice(at, 1);
        } else if (at >= 0) {
          entries[at] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const childTree = at >= 0 && entries[at].mode === '40000' ? entries[at].oid : null;
        const newChild = build(childTree, depth + 1);
        // Drop an emptied directory.
        const childObject = this.objects.get(newChild);
        const childEmpty = childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0;
        if (childEmpty) {
          if (at >= 0) entries.splice(at, 1);
        } else if (at >= 0) {
          entries[at] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(baseTreeOid, 0);
  }

  /** The blob oid at `path` in the tree, or null (with its mode). */
  entryAt(treeOid: string | null, path: string): { oid: string; mode: string } | null {
    if (treeOid === null) return null;
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      let found: TreeEntry | undefined;
      try {
        found = parseTree(object.data).find((entry) => entry.name === segments[depth]);
      } catch {
        return null;
      }
      if (!found) return null;
      if (depth === segments.length - 1) return { oid: found.oid, mode: found.mode };
      if (found.mode !== '40000') return null;
      current = found.oid;
    }
    return null;
  }

  /** The entries of the directory at `path` ('' for the root), or null when it is not a tree. */
  listDir(treeOid: string | null, path: string): TreeEntry[] | null {
    if (treeOid === null) return [];
    let current = treeOid;
    if (path !== '') {
      const segments = path.split('/').filter((segment) => segment !== '');
      for (const segment of segments) {
        const object = this.objects.get(current);
        if (!object || object.type !== 'tree') return null;
        let found: TreeEntry | undefined;
        try {
          found = parseTree(object.data).find((entry) => entry.name === segment);
        } catch {
          return null;
        }
        if (!found || found.mode !== '40000') return null;
        current = found.oid;
      }
    }
    const object = this.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    try {
      return parseTree(object.data);
    } catch {
      return null;
    }
  }

  /** Flatten a tree into path -> {oid, mode} for every blob (and subtree) entry. */
  flattenTree(treeOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, base: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        out.set(path, { oid: entry.oid, mode: entry.mode });
        if (entry.mode === '40000') walk(entry.oid, path);
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Diff two trees (null = empty): added/removed/modified blob paths. */
  diffTrees(baseTree: string | null, headTree: string | null): DiffEntry[] {
    const base = this.flattenTree(baseTree);
    const head = this.flattenTree(headTree);
    const out: DiffEntry[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && !h) {
        if (b.mode !== '40000') out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
      } else if (!b && h) {
        if (h.mode !== '40000') out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
      } else if (b && h && b.oid !== h.oid && b.mode !== '40000' && h.mode !== '40000') {
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
      } else if (b && h && b.mode !== h.mode) {
        out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ repos

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      dbId: this.nextRepoId++,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      issues: new Map(),
      issueOrder: [],
      prs: new Map(),
      prOrder: [],
      labels: new Map(),
      comments: new Map(),
      nextNumber: 1,
      createdSeq: this.nextSeq(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // ------------------------------------------------------------------ contents

  /**
   * Commit one file on `branch` (created from the default branch tip when the branch does
   * not exist yet). Returns the commit and blob shas, and whether the file is new.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    const baseTree = tip === null ? null : this.treeOfCommit(tip);
    const existing = this.entryAt(baseTree, path);
    const blobSha = this.putBlob(content);
    const newTree = this.updateTree(baseTree, path, blobSha);
    const commitSha = this.makeCommit(newTree, tip === null ? [] : [tip], message);
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created: existing === null };
  }

  /** Delete one file on `branch` and commit; null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const baseTree = this.treeOfCommit(tip);
    if (this.entryAt(baseTree, path) === null) return null;
    const newTree = this.updateTree(baseTree, path, null);
    const commitSha = this.makeCommit(newTree, [tip], message);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  // ------------------------------------------------------------------ issues

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      labels: labels.map((label) => ({ ...label })),
      seq: this.nextSeq(),
    };
    repo.issues.set(number, issue);
    repo.issueOrder.push(number);
    return issue;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment | null {
    if (!repo.issues.has(issueNumber)) return null;
    const comment: Comment = { id: this.nextId(), body, seq: this.nextSeq() };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // ------------------------------------------------------------------ pull requests

  createPullRequest(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const number = repo.nextNumber++;
    const pr: PullRequest = {
      id: this.nextId(),
      number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeSha: null,
      head,
      base,
      headSha,
      baseSha,
      seq: this.nextSeq(),
    };
    repo.prs.set(number, pr);
    repo.prOrder.push(number);
    return pr;
  }

  /** The changed files of a pull request (head tree vs the base tip recorded at creation). */
  prFiles(repo: Repo, pr: PullRequest): DiffEntry[] {
    const headTree = this.treeOfCommit(pr.headSha);
    const baseTree = this.treeOfCommit(pr.baseSha);
    return this.diffTrees(baseTree, headTree);
  }

  /** Would merging `pr` now conflict with what landed on the base branch since creation? */
  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const currentBase = repo.refs.get(`refs/heads/${pr.base}`);
    if (currentBase === undefined) return true;
    if (currentBase === pr.baseSha) return false;
    const headTree = this.treeOfCommit(pr.headSha);
    const baseTree = this.treeOfCommit(pr.baseSha);
    const currentTree = this.treeOfCommit(currentBase);
    const prDiff = this.diffTrees(baseTree, headTree);
    const landedDiff = this.diffTrees(baseTree, currentTree);
    const landed = new Map(landedDiff.map((entry) => [entry.path, entry]));
    for (const entry of prDiff) {
      const other = landed.get(entry.path);
      if (!other) continue;
      if (entry.newOid !== other.newOid) return true;
      if (entry.status === 'removed' && other.status !== 'removed') return true;
      if (other.status === 'removed' && entry.status !== 'removed') return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null
   * when the pull request is not open, or 'conflict' when it would conflict.
   */
  mergePullRequest(repo: Repo, pr: PullRequest): { sha: string } | { conflict: true } | null {
    if (pr.state !== 'open' || pr.merged) return null;
    if (this.prConflicts(repo, pr)) return { conflict: true };
    const currentBase = repo.refs.get(`refs/heads/${pr.base}`);
    if (currentBase === undefined) return null;
    const headTree = this.treeOfCommit(pr.headSha);
    if (headTree === null) return null;
    const message = `Merge pull request #${pr.number} from ${VIEWER.login}/${pr.head}`;
    const sha = this.makeCommit(headTree, [currentBase], message);
    repo.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = FIXED_ISO;
    pr.mergeSha = sha;
    return { sha };
  }

  // ------------------------------------------------------------------ ids

  /** An opaque, stable global (Relay) id for a node. */
  static globalId(kind: string, parts: readonly (string | number)[]): string {
    return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
  }

  /** Decode a global id this forge issued, or null. */
  static decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const at = text.indexOf(':');
      if (at <= 0) return null;
      const kind = text.slice(0, at);
      if (!/^[A-Za-z]+$/.test(kind)) return null;
      return { kind, parts: text.slice(at + 1).split(':') };
    } catch {
      return null;
    }
  }
}

/** Peel an annotated tag to its commit (following tag objects), or the oid itself. */
export function peelToCommit(store: Store, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);
    const object = store.getObject(current);
    if (!object || object.type !== 'tag') return current;
    try {
      current = parseTag(object.data).object;
    } catch {
      return current;
    }
  }
}

export { ZERO_OID };
