import type { BoardData, LinearClient } from "./linear.ts";

type BoardClient = Pick<LinearClient, "load" | "move"> & { dispose?(): void };
export const REFRESH_MS = 60_000;

export class BoardStore {
  data: BoardData | null = null;
  busy: "refresh" | "move" | null = null;
  error = "";
  private displayedTeam = "";
  private hidden = new Set<string>();
  private client: BoardClient | null = null;
  private listeners = new Set<() => void>();
  private lastReadAt = -Infinity;
  private retryAt = 0;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get connected(): boolean { return this.client !== null; }

  get teamId(): string { return this.displayedTeam; }

  setTeamFilter(teamId: string) {
    if (this.displayedTeam === teamId) return;
    this.displayedTeam = teamId;
    this.notify();
  }

  get hiddenColumns(): ReadonlySet<string> { return this.hidden; }

  setHiddenColumns(columns: string[]) {
    this.hidden = new Set(columns);
    this.notify();
  }

  setClient(client: BoardClient | null) {
    if (this.client === client) return;
    this.client?.dispose?.();
    this.client = client;
    this.data = null;
    this.busy = null;
    this.error = "";
    this.lastReadAt = -Infinity;
    this.retryAt = 0;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private recordError(error: unknown) {
    this.error = error instanceof Error ? error.message : "Linear에 연결할 수 없습니다.";
    if (error instanceof Error && "retryAfterMs" in error && typeof error.retryAfterMs === "number") {
      this.retryAt = this.now() + error.retryAfterMs;
    }
  }

  async refresh(force = false): Promise<void> {
    const client = this.client;
    if (!client || this.busy || this.now() < this.retryAt) return;
    if (!force && this.now() - this.lastReadAt < REFRESH_MS) return;
    this.lastReadAt = this.now();
    this.busy = "refresh";
    this.notify();
    try {
      const data = await client.load();
      if (this.client !== client) return;
      this.data = data;
      this.error = "";
    } catch (error) {
      if (this.client === client) this.recordError(error);
    } finally {
      if (this.client === client) {
        this.busy = null;
        this.notify();
      }
    }
  }

  canMove(issueId: string, stateId: string): boolean {
    const issue = this.data?.issues.find(item => item.id === issueId);
    if (!issue || this.busy || this.now() < this.retryAt || issue.stateId === stateId) return false;
    const team = this.data?.teams.find(team => team.id === issue.teamId);
    return !!team?.states.some(state => state.id === stateId && state.type !== "duplicate");
  }

  async move(issueId: string, stateId: string): Promise<void> {
    const client = this.client;
    const previous = this.data;
    if (!client || !previous || !this.canMove(issueId, stateId)) return;
    const withState = (id: string): BoardData => ({
      ...previous, issues: previous.issues.map(issue => issue.id === issueId ? { ...issue, stateId: id } : issue),
    });
    this.data = withState(stateId);
    this.error = "";
    this.busy = "move";
    this.notify();
    try {
      const confirmedState = await client.move(issueId, stateId);
      if (this.client === client) this.data = withState(confirmedState);
    } catch (error) {
      if (this.client !== client) return;
      this.data = previous;
      this.recordError(error);
      // A lost response can follow a successful write. Re-read without retrying the mutation.
      if (this.now() >= this.retryAt) {
        try {
          const actual = await client.load();
          if (this.client === client) {
            this.data = actual;
            this.lastReadAt = this.now();
            if (actual.issues.some(issue => issue.id === issueId && issue.stateId === stateId)) this.error = "";
          }
        } catch (readError) {
          if (this.client === client) this.recordError(readError);
        }
      }
    } finally {
      if (this.client === client) {
        this.busy = null;
        this.notify();
      }
    }
  }
}
