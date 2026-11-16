// GraphQL v4 for the documents gh and github-mcp-server send: a small parser for the
// query/mutation subset they use (variables, aliases, arguments, inline fragments,
// input objects, enums) and an executor over the same store REST uses.

import { Store, VIEWER, FIXED_ISO, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=|@&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j])) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j])) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  return tokens;
}

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

export type SelectionNode = FieldNode | FragmentNode;

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token)}`);
    return token.value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      type = token.value as 'query' | 'mutation';
      const next = this.peek();
      if (next !== undefined && next.kind === 'name') name = this.next().value as string;
    } else if (token !== undefined && token.kind === 'name' && token.value === 'subscription') {
      throw new Error('subscriptions are not supported');
    }
    const variables = this.isPunct('(') ? this.parseVariableDefinitions() : [];
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      let type = '';
      for (;;) {
        const token = this.peek();
        if (token === undefined) throw new Error('unexpected end of document in variable definition');
        if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) {
          type += token.value;
          this.next();
          continue;
        }
        if (token.kind === 'name') {
          type += token.value;
          this.next();
          continue;
        }
        break;
      }
      let defaultValue: ValueNode | null = null;
      if (this.isPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.isPunct('...')) {
      this.next();
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token !== undefined && token.kind === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (token !== undefined && token.kind === 'name') {
        // A named fragment spread: not used by the suite's documents; skip its selections.
        this.next();
        return { kind: 'fragment', typeCondition: null, selections: [] };
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.isPunct(':')) {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    // Directives (@...) are not used by the suite; skip them.
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.isPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.isPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseDocument(query: string): Operation[] {
  return new Parser(tokenize(query)).parseDocument();
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueOf(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// schema surface (for __type and for unknown-field validation)
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'mergedAt', 'mergeCommit', 'author', 'createdAt', 'updatedAt'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'];

const ALLOWED_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  Repository: new Set(REPOSITORY_FIELDS),
  Issue: new Set(ISSUE_FIELDS),
  PullRequest: new Set(PULL_REQUEST_FIELDS),
  User: new Set(['id', 'login', 'name', 'email', 'avatarUrl']),
  Ref: new Set(['id', 'name', 'prefix', 'target']),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'clientMutationId']),
  CommentEdge: new Set(['node', 'cursor']),
  IssueComment: new Set(['id', 'body', 'author', 'createdAt', 'updatedAt']),
  __Type: new Set(['name', 'kind', 'fields', 'enumValues', 'description', 'inputFields', 'interfaces', 'possibleTypes']),
  __Field: new Set(['name', 'description', 'args', 'type']),
  __EnumValue: new Set(['name', 'description']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
};

/** The return type of a field, for recursing into sub-selections (null = scalar). */
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: '[Issue]', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: '[PullRequest]', pageInfo: 'PageInfo' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'CommentEdge' },
  CommentEdge: { node: 'IssueComment' },
  __Type: { fields: '[__Field]', enumValues: '[__EnumValue]' },
};

// ---------------------------------------------------------------------------
// resolved values
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown> & { __typename: string };

function issueState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoInternal(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}

function issueInternal(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}

function prInternal(repo: Repo, pr: PullRequest): AnyObj {
  return { __typename: 'PullRequest', repo, pr };
}

function userInternal(login: string): AnyObj {
  return { __typename: 'User', login };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
}

export interface GraphQLExecution {
  data: Record<string, unknown> | null;
  errors: GraphQLError[];
}

export class GraphQLExecutor {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /**
   * Execute a request body as the clients send it: one {query, variables, operationName}
   * object, or an array of them (batched) answered with an array of results in order.
   */
  executeBody(body: unknown): GraphQLExecution | GraphQLExecution[] {
    if (Array.isArray(body)) {
      return body.map((item) => this.executeOne(item));
    }
    return this.executeOne(body);
  }

  private executeOne(body: unknown): GraphQLExecution {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { data: null, errors: [{ message: 'GraphQL parse error: request body must be an object with a query string' }] };
    }
    const request = body as Record<string, unknown>;
    if (typeof request.query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL parse error: request body must be an object with a query string' }] };
    }
    const variables = (request.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof request.operationName === 'string' ? request.operationName : null;
    return this.execute(request.query, variables, operationName);
  }

  execute(query: string, variables: Record<string, unknown>, operationName?: string | null): GraphQLExecution {
    let operations: Operation[];
    try {
      operations = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: `GraphQL parse error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (operations.length === 0) {
      return { data: null, errors: [{ message: 'GraphQL parse error: empty document' }] };
    }
    let operation: Operation | undefined;
    if (operationName !== undefined && operationName !== null) {
      operation = operations.find((candidate) => candidate.name === operationName);
      if (operation === undefined) {
        return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
      }
    } else if (operations.length === 1) {
      operation = operations[0];
    } else {
      return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
    }
    const mergedVariables: Record<string, unknown> = { ...variables };
    for (const def of operation.variables) {
      if (!(def.name in mergedVariables) && def.defaultValue !== null) {
        mergedVariables[def.name] = valueOf(def.defaultValue, mergedVariables);
      }
    }
    const errors: GraphQLError[] = [];
    const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
    const data = this.resolveSelections(rootType, {}, operation.selections, mergedVariables, errors, []);
    return { data, errors };
  }

  private resolveSelections(
    typeName: string,
    source: Record<string, unknown>,
    selections: SelectionNode[],
    variables: Record<string, unknown>,
    errors: GraphQLError[],
    path: (string | number)[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // `node(id:)` answers a dynamic type: validate and recurse against the value's own type.
    const effectiveType =
      typeName === 'Node' && typeof source.__typename === 'string' ? source.__typename : typeName;
    const allowed = ALLOWED_FIELDS[effectiveType];
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        const sourceType = typeof source.__typename === 'string' ? source.__typename : typeName;
        if (selection.typeCondition !== null && selection.typeCondition !== sourceType) continue;
        const nested = this.resolveSelections(typeName, source, selection.selections, variables, errors, path);
        Object.assign(out, nested);
        continue;
      }
      const key = selection.alias ?? selection.name;
      if (allowed !== undefined && !allowed.has(selection.name)) {
        errors.push({
          message: `Cannot query field "${selection.name}" on type "${effectiveType}".`,
          path: [...path, key],
        });
        out[key] = null;
        continue;
      }
      const args = argsOf(selection, variables);
      const value = this.resolveField(effectiveType, source, selection.name, args, variables, errors, [...path, key]);
      const fieldType = FIELD_TYPES[effectiveType]?.[selection.name];
      if (value === null || value === undefined) {
        out[key] = null;
      } else if (selection.selections.length > 0 && fieldType !== undefined && fieldType !== '') {
        const elementType = fieldType.startsWith('[') ? fieldType.slice(1, -1) : fieldType;
        if (Array.isArray(value)) {
          out[key] = value.map((entry, index) =>
            entry !== null && typeof entry === 'object'
              ? this.resolveSelections(elementType, entry as Record<string, unknown>, selection.selections, variables, errors, [...path, key, index])
              : entry,
          );
        } else if (typeof value === 'object') {
          out[key] = this.resolveSelections(elementType, value as Record<string, unknown>, selection.selections, variables, errors, [...path, key]);
        } else {
          out[key] = value;
        }
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private resolveField(
    typeName: string,
    source: Record<string, unknown>,
    field: string,
    args: Record<string, unknown>,
    variables: Record<string, unknown>,
    errors: GraphQLError[],
    path: (string | number)[],
  ): unknown {
    switch (typeName) {
      case 'Query':
        return this.queryField(field, args, errors, path);
      case 'Mutation':
        return this.mutationField(field, args, errors, path);
      case 'Repository':
        return this.repositoryField(source, field, args);
      case 'Issue':
        return this.issueField(source, field);
      case 'PullRequest':
        return this.prField(source, field, args);
      case 'User':
        return this.userField(source, field);
      case 'Ref':
        return source.name ?? null;
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection': {
        if (field === 'nodes') return (source.nodes as unknown[]) ?? [];
        if (field === 'pageInfo') return source.pageInfo ?? { hasNextPage: false, endCursor: null };
        if (field === 'totalCount') return Array.isArray(source.nodes) ? source.nodes.length : 0;
        return null;
      }
      case 'PullRequestChangedFile':
        return field === 'path' ? (source.path ?? null) : 0;
      case 'PageInfo':
        return source[field] ?? null;
      case 'CreateIssuePayload':
      case 'CloseIssuePayload':
        return source.issue ?? null;
      case 'CreatePullRequestPayload':
      case 'MergePullRequestPayload':
        return source.pullRequest ?? null;
      case 'AddCommentPayload':
        return source.commentEdge ?? null;
      case 'CommentEdge':
        return source.node ?? null;
      case 'IssueComment':
        return field === 'id' ? (source.id ?? null) : field === 'body' ? (source.body ?? null) : field === 'createdAt' || field === 'updatedAt' ? FIXED_ISO : null;
      case '__Type':
        return this.typeField(source, field, args);
      case '__Field':
        return field === 'name' ? (source.name ?? null) : null;
      case '__EnumValue':
        return field === 'name' ? (source.name ?? null) : null;
      default:
        return null;
    }
  }

  private queryField(field: string, args: Record<string, unknown>, errors: GraphQLError[], path: (string | number)[]): unknown {
    if (field === 'viewer') return userInternal(VIEWER.login);
    if (field === 'repository') {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== VIEWER.login) return null;
      const repo = this.store.getRepo(name);
      return repo === undefined ? null : repoInternal(repo);
    }
    if (field === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      return this.nodeById(id);
    }
    if (field === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      return this.introspectType(name);
    }
    return null;
  }

  private nodeById(id: string): AnyObj | null {
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const dbId = Number(decoded.parts[0]);
      for (const repo of this.store.repos.values()) {
        if (repo.dbId === dbId) return repoInternal(repo);
      }
      return null;
    }
    if (decoded.kind === 'Issue') {
      const dbId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of this.store.repos.values()) {
        if (repo.dbId === dbId) {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : issueInternal(repo, issue);
        }
      }
      return null;
    }
    if (decoded.kind === 'PullRequest') {
      const dbId = Number(decoded.parts[0]);
      const number = Number(decoded.parts[1]);
      for (const repo of this.store.repos.values()) {
        if (repo.dbId === dbId) {
          const pr = repo.prs.get(number);
          return pr === undefined ? null : prInternal(repo, pr);
        }
      }
      return null;
    }
    return null;
  }

  private introspectType(name: string): AnyObj | null {
    if (name === 'Issue') {
      return { __typename: '__Type', name, kind: 'OBJECT', fields: ISSUE_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: [] };
    }
    if (name === 'PullRequest') {
      return { __typename: '__Type', name, kind: 'OBJECT', fields: PULL_REQUEST_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: [] };
    }
    if (name === 'Repository') {
      return { __typename: '__Type', name, kind: 'OBJECT', fields: REPOSITORY_FIELDS.map((field) => ({ __typename: '__Field', name: field })), enumValues: [] };
    }
    if (name === 'SearchType') {
      return { __typename: '__Type', name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value })) };
    }
    if (name === 'User') {
      return { __typename: '__Type', name, kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'].map((field) => ({ __typename: '__Field', name: field })), enumValues: [] };
    }
    if (name === 'IssueState') {
      return { __typename: '__Type', name, kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'].map((value) => ({ __typename: '__EnumValue', name: value })) };
    }
    return null;
  }

  private typeField(source: Record<string, unknown>, field: string, args: Record<string, unknown>): unknown {
    if (field === 'name') return source.name ?? null;
    if (field === 'kind') return source.kind ?? null;
    if (field === 'fields') return (source.fields as unknown[]) ?? [];
    if (field === 'enumValues') return (source.enumValues as unknown[]) ?? [];
    return null;
  }

  private repositoryField(source: Record<string, unknown>, field: string, args: Record<string, unknown>): unknown {
    const repo = source.repo as Repo;
    switch (field) {
      case 'id':
        return Store.globalId('Repository', [repo.dbId]);
      case 'databaseId':
        return repo.dbId;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${VIEWER.login}/${repo.name}`;
      case 'owner':
        return userInternal(VIEWER.login);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip === undefined ? null : { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'url':
        return `/${VIEWER.login}/${repo.name}`;
      case 'issue': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueInternal(repo, issue);
      }
      case 'issues': {
        const nodes = this.issueNodes(repo, args);
        return this.connection(nodes, args);
      }
      case 'pullRequests': {
        const nodes: AnyObj[] = [];
        const first = typeof args.first === 'number' ? args.first : 100;
        for (const number of repo.prOrder) {
          const pr = repo.prs.get(number)!;
          if (pr.state !== 'open') continue;
          nodes.push(prInternal(repo, pr));
          if (nodes.length >= first) break;
        }
        return { __typename: 'PullRequestConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: false, endCursor: null } };
      }
      case 'pullRequest': {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pr = repo.prs.get(number);
        return pr === undefined ? null : prInternal(repo, pr);
      }
      default:
        return null;
    }
  }

  private issueNodes(repo: Repo, args: Record<string, unknown>): AnyObj[] {
    const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
    let numbers = [...repo.issueOrder];
    if (states !== null) {
      const wanted = new Set(states.map((state) => state.toLowerCase()));
      numbers = numbers.filter((number) => wanted.has(repo.issues.get(number)!.state));
    }
    numbers.sort((a, b) => {
      const issueA = repo.issues.get(a)!;
      const issueB = repo.issues.get(b)!;
      if (direction === 'ASC') return issueA.seq - issueB.seq || a - b;
      return issueB.seq - issueA.seq || b - a;
    });
    return numbers.map((number) => issueInternal(repo, repo.issues.get(number)!));
  }

  private connection(nodes: AnyObj[], args: Record<string, unknown>): AnyObj {
    const first = typeof args.first === 'number' ? args.first : nodes.length;
    const afterNumber = numberFromCursor(args.after);
    let start = 0;
    if (afterNumber !== null) {
      const index = nodes.findIndex((node) => {
        const issue = (node as AnyObj).issue as Issue | undefined;
        const pr = (node as AnyObj).pr as PullRequest | undefined;
        return (issue?.number ?? pr?.number) === afterNumber;
      });
      start = index < 0 ? nodes.length : index + 1;
    }
    const page = nodes.slice(start, start + first);
    const hasNextPage = start + page.length < nodes.length;
    let endCursor: string | null = null;
    if (page.length > 0) {
      const last = page[page.length - 1];
      const issue = (last as AnyObj).issue as Issue | undefined;
      const pr = (last as AnyObj).pr as PullRequest | undefined;
      const number = issue?.number ?? pr?.number;
      endCursor = number === undefined ? null : cursorFor(number);
    }
    return {
      __typename: 'IssueConnection',
      nodes: page,
      pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor },
    };
  }

  private issueField(source: Record<string, unknown>, field: string): unknown {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    switch (field) {
      case 'id':
        return Store.globalId('Issue', [repo.dbId, issue.number]);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issueState(issue.state);
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'author':
        return userInternal(VIEWER.login);
      case 'url':
        return `/${VIEWER.login}/${repo.name}/issues/${issue.number}`;
      default:
        return null;
    }
  }

  private prField(source: Record<string, unknown>, field: string, args: Record<string, unknown>): unknown {
    const repo = source.repo as Repo;
    const pr = source.pr as PullRequest;
    switch (field) {
      case 'id':
        return Store.globalId('PullRequest', [repo.dbId, pr.number]);
      case 'number':
        return pr.number;
      case 'title':
        return pr.title;
      case 'body':
        return pr.body;
      case 'state':
        return prState(pr);
      case 'merged':
        return pr.merged;
      case 'mergeable': {
        if (pr.state !== 'open') return 'UNKNOWN';
        return this.store.prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'headRefName':
        return pr.head;
      case 'baseRefName':
        return pr.base;
      case 'headRefOid':
        return repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
      case 'baseRefOid':
        return repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
      case 'mergedAt':
        return pr.mergedAt;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_ISO;
      case 'author':
        return userInternal(VIEWER.login);
      case 'files': {
        const diff = this.store.prFiles(repo, pr);
        const first = typeof args.first === 'number' ? args.first : diff.length;
        const nodes = diff.slice(0, first).map((entry) => ({ __typename: 'PullRequestChangedFile', path: entry.path }));
        return { __typename: 'PullRequestChangedFileConnection', nodes, pageInfo: { __typename: 'PageInfo', hasNextPage: diff.length > first, endCursor: null } };
      }
      default:
        return null;
    }
  }

  private userField(source: Record<string, unknown>, field: string): unknown {
    const login = source.login as string;
    switch (field) {
      case 'id':
        return Store.globalId('User', [VIEWER.id]);
      case 'login':
        return login;
      case 'name':
        return login === VIEWER.login ? VIEWER.name : login;
      case 'email':
        return login === VIEWER.login ? VIEWER.email : `${login}@example.invalid`;
      default:
        return null;
    }
  }

  private mutationField(field: string, args: Record<string, unknown>, errors: GraphQLError[], path: (string | number)[]): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = this.store.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', issue: issueInternal(repo, issue) };
    }
    if (field === 'closeIssue') {
      const found = this.issueByGlobalId(input.issueId);
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: issueInternal(found.repo, found.issue) };
    }
    if (field === 'createPullRequest') {
      const repo = this.repoByGlobalId(input.repositoryId);
      if (repo === null) {
        errors.push({ message: 'Could not resolve to a Repository with the id provided.', path });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const pr = this.store.createPullRequest(repo, title, body, head, base);
      if (pr === null) {
        errors.push({ message: 'Could not create a pull request: the head or base branch does not exist.', path });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: prInternal(repo, pr) };
    }
    if (field === 'mergePullRequest') {
      const found = this.prByGlobalId(input.pullRequestId);
      if (found === null) {
        errors.push({ message: 'Could not resolve to a PullRequest with the id provided.', path });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const result = this.store.mergePullRequest(found.repo, found.pr);
      if (result === null || 'conflict' in result) {
        errors.push({ message: 'Pull request cannot be merged: it is conflicted or already closed.', path });
        return { __typename: 'MergePullRequestPayload', pullRequest: prInternal(found.repo, found.pr) };
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: prInternal(found.repo, found.pr) };
    }
    if (field === 'addComment') {
      const found = this.issueByGlobalId(input.subjectId);
      if (found === null) {
        errors.push({ message: 'Could not resolve to an Issue with the id provided.', path });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = this.store.createComment(found.repo, found.issue.number, body);
      if (comment === null) {
        errors.push({ message: 'Could not add a comment.', path });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const node = { __typename: 'IssueComment', id: Store.globalId('IssueComment', [found.repo.dbId, found.issue.number, comment.id]), body: comment.body };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node } };
    }
    return null;
  }

  private repoByGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') return null;
    const dbId = Number(decoded.parts[0]);
    for (const repo of this.store.repos.values()) {
      if (repo.dbId === dbId) return repo;
    }
    return null;
  }

  private issueByGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return null;
    const dbId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.store.repos.values()) {
      if (repo.dbId === dbId) {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { repo, issue };
      }
    }
    return null;
  }

  private prByGlobalId(id: unknown): { repo: Repo; pr: PullRequest } | null {
    if (typeof id !== 'string') return null;
    const decoded = Store.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return null;
    const dbId = Number(decoded.parts[0]);
    const number = Number(decoded.parts[1]);
    for (const repo of this.store.repos.values()) {
      if (repo.dbId === dbId) {
        const pr = repo.prs.get(number);
        return pr === undefined ? null : { repo, pr };
      }
    }
    return null;
  }
}
