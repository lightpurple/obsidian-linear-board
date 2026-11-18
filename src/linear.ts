export interface WorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  color: string;
}

export interface Team {
  id: string;
  key: string;
  name: string;
  states: WorkflowState[];
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  stateId: string;
}

export interface BoardData {
  teams: Team[];
  issues: Issue[];
}

type Transport = (request: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  throw: false;
}) => Promise<{ status: number; text: string; headers: Record<string, string> }>;

type AssignedIssue = Pick<Issue, "id" | "identifier" | "title" | "url"> & {
  team: Omit<Team, "states">;
  state: { id: string };
};

type Page<T> = {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

type GraphQLReply<T> = {
  data?: T;
  errors?: { extensions?: { code?: string; type?: string } }[];
};

const assignedIssuesQuery = `
  query AssignedIssues($after: String) {
    viewer {
      assignedIssues(first: 100, after: $after, includeArchived: false) {
        nodes { id identifier title url team { id key name } state { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const teamStatesQuery = `
  query TeamStates($teamId: String!, $after: String) {
    team(id: $teamId) {
      states(first: 100, after: $after, includeArchived: false) {
        nodes { id name type position color }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const moveIssueMutation = `
  mutation MoveIssue($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
      issue { id state { id } }
    }
  }`;

const stateTypes = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];

function stateGroup(type: string): number {
  const index = stateTypes.indexOf(type);
  return index < 0 ? stateTypes.length : index;
}

function invalidResponse(): Error {
  return new Error("Linear 응답을 확인할 수 없습니다. 보드를 새로 고쳐 주세요.");
}

function hasText<T extends object>(record: T | null | undefined, ...fields: (keyof T)[]): boolean {
  return record != null && fields.every((field) => typeof record[field] === "string" && record[field] !== "");
}

async function collectPages<T extends { id: string }>(
  getPage: (after: string | null) => Promise<Page<T> | undefined>,
): Promise<T[]> {
  const nodes = new Map<string, T>();
  const cursors = new Set<string>();
  let after: string | null = null;
  while (true) {
    const page = await getPage(after);
    if (!Array.isArray(page?.nodes) || typeof page?.pageInfo?.hasNextPage !== "boolean") throw invalidResponse();
    for (const node of page.nodes) {
      if (!hasText(node, "id")) throw invalidResponse();
      nodes.set(node.id, node);
    }
    if (!page.pageInfo.hasNextPage) return [...nodes.values()];
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) throw invalidResponse();
    cursors.add(cursor);
    after = cursor;
  }
}

function retryDelay(rawHeaders: Record<string, string>): number {
  const headers = new Headers(rawHeaders);
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const quotas = ["requests", "endpoint-requests", "complexity"].map((bucket) => {
    const remaining = headers.get(`x-ratelimit-${bucket}-remaining`);
    return {
      remaining: remaining === null ? null : Number(remaining),
      resetsAt: Number(headers.get(`x-ratelimit-${bucket}-reset`)),
    };
  });
  const exhausted = quotas.filter(({ remaining }) => remaining !== null && remaining <= 0);
  const relevant = exhausted.length ? exhausted : quotas.filter(({ remaining }) => remaining === null);
  const delay = Math.max(...relevant.map(({ resetsAt }) => resetsAt).filter(Number.isFinite)) - Date.now();
  return delay > 0 ? delay : 60_000;
}

export class LinearClient {
  #apiKey: string | null;
  readonly #send: Transport;

  constructor(apiKey: string, send: Transport) {
    this.#apiKey = apiKey.trim();
    this.#send = send;
  }

  dispose(): void {
    this.#apiKey = null;
  }

  async load(): Promise<BoardData> {
    const assigned = await collectPages<AssignedIssue>(async (after) => {
      const data = await this.#request<{ viewer: { assignedIssues: Page<AssignedIssue> } }>(assignedIssuesQuery, { after });
      return data.viewer?.assignedIssues;
    });
    const teams = new Map<string, Team>();
    const issues = assigned.map((issue) => {
      const { team, state, id, identifier, title, url } = issue;
      if (!hasText(issue, "identifier", "title", "url") || !hasText(team, "id", "key", "name") || !hasText(state, "id")) {
        throw invalidResponse();
      }
      if (!teams.has(team.id)) teams.set(team.id, { id: team.id, key: team.key, name: team.name, states: [] });
      return { id, identifier, title, url, teamId: team.id, stateId: state.id };
    });

    const availableStates = new Map<string, Set<string>>();
    for (const team of teams.values()) {
      const states = await collectPages<WorkflowState>(async (after) => {
        const data = await this.#request<{ team: { states: Page<WorkflowState> } }>(teamStatesQuery, { teamId: team.id, after });
        return data.team?.states;
      });
      if (states.some((state) => !hasText(state, "name", "type", "color") || !Number.isFinite(state.position))) {
        throw invalidResponse();
      }
      team.states = states.sort((a, b) =>
        stateGroup(a.type) - stateGroup(b.type) || a.position - b.position || a.name.localeCompare(b.name));
      availableStates.set(team.id, new Set(states.map((state) => state.id)));
    }
    if (issues.some((issue) => !availableStates.get(issue.teamId)?.has(issue.stateId))) {
      throw new Error("조회하는 동안 팀 상태가 변경되었습니다. 보드를 새로 고쳐 주세요.");
    }
    return { teams: [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)), issues };
  }

  async move(issueId: string, stateId: string): Promise<string> {
    const data = await this.#request<{
      issueUpdate: { success: boolean; issue: { id: string; state: { id: string } } | null };
    }>(moveIssueMutation, { issueId, stateId });
    const result = data.issueUpdate;
    if (result?.success !== true || result.issue?.id !== issueId || !hasText(result.issue.state, "id")) {
      throw new Error("Linear에서 상태 변경 결과를 확인할 수 없습니다. 보드를 새로 고쳐 주세요.");
    }
    return result.issue.state.id;
  }

  #activeKey(): string {
    if (this.#apiKey === null) throw new Error("Linear 연결이 종료되었습니다.");
    if (!this.#apiKey) throw new Error("플러그인 설정에서 Linear 개인 API 키를 입력해 주세요.");
    return this.#apiKey;
  }

  async #request<T>(query: string, variables: Record<string, string | null>): Promise<T> {
    const apiKey = this.#activeKey();
    let response: Awaited<ReturnType<Transport>>;
    try {
      response = await this.#send({
        url: "https://api.linear.app/graphql",
        method: "POST",
        headers: { Authorization: apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        throw: false,
      });
    } catch {
      throw new Error("Linear에 연결할 수 없습니다. 네트워크 연결을 확인한 뒤 보드를 새로 고쳐 주세요.");
    }
    this.#activeKey();

    let reply: GraphQLReply<T> | null = null;
    try {
      reply = JSON.parse(response.text);
    } catch {
      // A proxy can return HTML on HTTP errors; the status still identifies the failure.
    }
    const errors = Array.isArray(reply?.errors) ? reply.errors : [];
    const errorCodes = new Set(errors.flatMap((error) => [error?.extensions?.code, error?.extensions?.type])
      .filter((code): code is string => typeof code === "string")
      .map((code) => code.toUpperCase().replace(/[\s_-]/g, "")));
    if (response.status === 429 || errorCodes.has("RATELIMITED")) {
      throw Object.assign(new Error("Linear API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."), {
        retryAfterMs: retryDelay(response.headers),
      });
    }
    if (response.status === 401 || errorCodes.has("AUTHENTICATIONERROR") || errorCodes.has("UNAUTHENTICATED")) {
      throw new Error("Linear 인증에 실패했습니다. 플러그인 설정에서 개인 API 키를 확인해 주세요.");
    }
    if (response.status === 403 || errorCodes.has("FORBIDDEN")) {
      throw new Error("Linear 접근 권한이 없습니다. 개인 API 키의 권한과 팀 접근 범위를 확인해 주세요.");
    }
    if (response.status < 200 || response.status >= 300 || errors.length > 0) {
      throw new Error("Linear에서 요청을 처리하지 못했습니다. 잠시 후 보드를 새로 고쳐 주세요.");
    }
    if (!reply?.data || typeof reply.data !== "object" || (reply.errors != null && !Array.isArray(reply.errors))) {
      throw invalidResponse();
    }
    return reply.data;
  }
}
