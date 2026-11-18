import type { Issue, Team, WorkflowState } from "./linear.ts";
import { BoardStore } from "./store.ts";

const DRAG_TYPE = "application/x-obsidian-linear-issue";

function add<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls: string, text?: string) {
  const el = parent.ownerDocument.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  parent.append(el);
  return el;
}

export class BoardWidget {
  private root: HTMLElement;
  private store: BoardStore;
  private configure: () => void;
  private isLive: () => boolean;
  private dragged: Issue | null = null;
  private restoreFocus: string | null = null;

  constructor(root: HTMLElement, store: BoardStore, configure: () => void, isLive = () => true) {
    this.root = root;
    this.store = store;
    this.configure = configure;
    this.isLive = isLive;
  }

  get dragging(): boolean { return this.dragged !== null; }
  get selecting(): boolean {
    const active = this.root.ownerDocument.activeElement;
    return active?.tagName === "SELECT" && this.root.contains(active);
  }

  render() {
    if (this.dragging && this.isLive()) return;
    this.dragged = null;
    const { root, store } = this;
    const scroll = new Map(Array.from(root.querySelectorAll<HTMLElement>(".ldb-lanes"), el => [el.dataset.team, el.scrollLeft]));
    const cardScroll = new Map(Array.from(root.querySelectorAll<HTMLElement>(".ldb-cards"), el => [el.dataset.column, el.scrollTop]));
    const active = root.ownerDocument.activeElement;
    if (active && root.contains(active)) this.restoreFocus = active.getAttribute("data-focus");
    else if (active && active !== root.ownerDocument.body) this.restoreFocus = null;
    root.replaceChildren();
    if (!this.isLive()) return;
    root.classList.add("linear-daily-board");
    if (!store.connected) {
      add(root, "p", "ldb-hint", "내 담당 이슈를 보려면 Linear API 키를 연결하세요.");
      add(root, "button", "mod-cta", "Linear 연결").onclick = this.configure;
      return;
    }
    const header = add(root, "div", "ldb-header");
    add(header, "span", "ldb-caption", "Linear · 내 담당 이슈");
    const refresh = add(header, "button", "ldb-refresh", "새로고침");
    refresh.dataset.focus = "refresh";
    refresh.disabled = !!store.busy;
    refresh.onclick = () => { if (this.isLive()) void store.refresh(true); };
    if (store.busy) {
      add(header, "span", "ldb-hint", store.busy === "move" ? "저장 중…" : "불러오는 중…").setAttribute("role", "status");
    }
    if (store.error) {
      const alert = add(root, "div", "ldb-error");
      alert.setAttribute("role", "alert");
      add(alert, "span", "", store.error);
      add(alert, "button", "", "연결 설정").onclick = this.configure;
    }
    const board = store.data;
    if (!board) return;
    if (!board.issues.length) add(root, "p", "ldb-hint", "현재 내게 배정된 이슈가 없습니다.");
    const grouped = new Map<string, Issue[]>();
    for (const issue of board.issues) {
      const key = issue.teamId + "/" + issue.stateId;
      const cards = grouped.get(key);
      if (cards) cards.push(issue);
      else grouped.set(key, [issue]);
    }
    for (const team of board.teams) {
      const section = add(root, "section", "ldb-team");
      add(section, "div", "ldb-team-name", team.name);
      const lanes = add(section, "div", "ldb-lanes");
      lanes.dataset.team = team.id;
      for (const state of team.states) {
        const key = team.id + "/" + state.id;
        const list = this.column(lanes, team, state, grouped.get(key) ?? []);
        list.dataset.column = key;
        list.scrollTop = cardScroll.get(key) ?? 0;
      }
      lanes.scrollLeft = scroll.get(team.id) ?? 0;
    }
    if (this.restoreFocus && !store.busy) {
      const target = Array.from(root.querySelectorAll<HTMLElement>("[data-focus]")).find(el => el.dataset.focus === this.restoreFocus);
      target?.focus({ preventScroll: true });
      this.restoreFocus = null;
    }
  }

  private column(parent: HTMLElement, team: Team, state: WorkflowState, cards: Issue[]) {
    const column = add(parent, "section", "ldb-column");
    column.dataset.stateId = state.id;
    column.setAttribute("aria-label", team.name + " · " + state.name);
    const heading = add(column, "div", "ldb-column-heading");
    const dot = add(heading, "span", "ldb-dot");
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(state.color)) dot.style.backgroundColor = state.color;
    add(heading, "span", "", state.name);
    add(heading, "span", "ldb-count", String(cards.length));
    const list = add(column, "div", "ldb-cards");
    for (const issue of cards) this.card(list, issue, team);
    column.addEventListener("dragover", event => {
      if (!event.dataTransfer || this.dragged?.teamId !== team.id || !this.store.canMove(this.dragged.id, state.id)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("is-drop-target");
    });
    column.addEventListener("dragleave", event => {
      if (!column.contains(event.relatedTarget as Node | null)) column.classList.remove("is-drop-target");
    });
    column.addEventListener("drop", event => {
      const issue = this.dragged;
      if (!issue || event.dataTransfer?.getData(DRAG_TYPE) !== issue.id) return;
      event.preventDefault();
      event.stopPropagation();
      this.dragged = null;
      column.classList.remove("is-drop-target");
      if (this.isLive() && issue.teamId === team.id) void this.store.move(issue.id, state.id);
    });
    return list;
  }

  private card(column: HTMLElement, issue: Issue, team: Team) {
    const card = add(column, "article", "ldb-card");
    card.draggable = !this.store.busy;
    card.addEventListener("dragstart", event => {
      if (this.store.busy || !event.dataTransfer || !this.isLive()) { event.preventDefault(); return; }
      this.dragged = issue;
      event.dataTransfer.setData(DRAG_TYPE, issue.id);
      event.dataTransfer.effectAllowed = "move";
      event.stopPropagation();
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => {
      this.dragged = null;
      this.render();
    });
    add(card, "span", "ldb-identifier", issue.identifier);
    const link = add(card, "a", "ldb-title", issue.title);
    if (issue.url.startsWith("https://linear.app/")) link.href = issue.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.draggable = false;
    const select = add(card, "select", "ldb-state-select");
    select.setAttribute("aria-label", issue.identifier + " 상태 변경");
    select.dataset.focus = issue.id;
    for (const state of team.states) {
      const option = add(select, "option", "", state.name);
      option.value = state.id;
      option.disabled = state.type === "duplicate";
    }
    select.value = issue.stateId;
    select.disabled = !!this.store.busy;
    select.onchange = () => {
      const next = select.value;
      select.value = issue.stateId;
      if (this.isLive()) void this.store.move(issue.id, next);
    };
  }
}
