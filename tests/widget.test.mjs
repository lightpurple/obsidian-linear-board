import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { BoardStore } from "../src/store.ts";
import { BoardWidget } from "../src/widget.ts";

function boardData() {
  const state = (id, name, type) => ({ id, name, type, position: 0, color: "#888888" });
  return {
    teams: [{ id: "team", name: "제품팀", key: "DEV", states: [state("todo", "Todo", "unstarted"), state("doing", "In Progress", "started")] }],
    issues: [{ id: "i", identifier: "DEV-3", title: "배포 확인", url: "https://linear.app/demo/issue/DEV-3", teamId: "team", stateId: "todo" }],
  };
}

test("dragging a rendered card to an empty column commits the move and shows the linked issue in that column", async () => {
  const dom = new JSDOM("<main></main>");
  const el = dom.window.document.querySelector("main");
  const store = new BoardStore();
  const saved = [];
  store.setClient({ load: async () => boardData(), move: async (id, state) => { saved.push([id, state]); return state; } });
  const widget = new BoardWidget(el, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  const transfer = new Map();
  const dataTransfer = { setData: (k, v) => transfer.set(k, v), getData: k => transfer.get(k) || "" };
  function drag(target, type) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    target.dispatchEvent(event);
  }
  const column = () => el.querySelector('[data-state-id="doing"]');
  const card = el.querySelector('[draggable="true"]');
  assert.equal(column().querySelector("a"), null);
  drag(card, "dragstart");
  drag(column(), "dragover");
  drag(column(), "drop");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(saved, [["i", "doing"]]);
  assert.equal(column().querySelector("a").href, "https://linear.app/demo/issue/DEV-3");
});

test("the status control works without drag and a server rejection returns the card to its original column", async () => {
  const dom = new JSDOM("<main></main>");
  const el = dom.window.document.querySelector("main");
  const store = new BoardStore();
  store.setClient({ load: async () => boardData(), move: async () => { throw new Error("상태를 변경할 권한이 없습니다."); } });
  const widget = new BoardWidget(el, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  const select = el.querySelector('select[aria-label*="DEV-3"]');
  select.value = "doing";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el.querySelector('[data-state-id="todo"] select').value, "todo");
  assert.match(el.querySelector('[role="alert"]').textContent, /권한/);
});

test("the connection prompt opens credential setup without querying issues", () => {
  const el = new JSDOM("<main></main>").window.document.querySelector("main");
  let prompted = false;
  const widget = new BoardWidget(el, new BoardStore(), () => { prompted = true; });
  widget.render();
  el.querySelector("button").click();
  assert.equal(prompted, true);
});

test("teams sharing inherited workflow state IDs only show and accept their own cards", async () => {
  const dom = new JSDOM("<main></main>");
  const el = dom.window.document.querySelector("main");
  const data = boardData();
  data.teams.push({ ...data.teams[0], id: "subteam", key: "SUB", name: "하위 팀" });
  const written = [];
  const store = new BoardStore();
  store.setClient({ load: async () => data, move: async (id, state) => { written.push(id); return state; } });
  const widget = new BoardWidget(el, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  const subteam = el.querySelector('[data-team="subteam"]');
  assert.equal(subteam.querySelector("article"), null);
  const drop = subteam.querySelector('[data-state-id="doing"]');
  let payload = "";
  const transfer = { setData: (_, v) => { payload = v; }, getData: () => payload };
  for (const [target, type] of [[el.querySelector("article"), "dragstart"], [drop, "drop"]]) {
    const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: transfer });
    target.dispatchEvent(e);
  }
  assert.deepEqual(written, []);
});

test("the keyboard status control keeps focus after saving unless the user focuses something else", async () => {
  const doc = new JSDOM("<main></main><button id='outside'>outside</button>").window.document;
  const root = doc.querySelector("main");
  const store = new BoardStore();
  let finish;
  store.setClient({ load: async () => boardData(), move: () => new Promise(resolve => { finish = resolve; }) });
  const widget = new BoardWidget(root, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  root.querySelector("select").focus();
  await store.refresh(true);
  assert.equal(doc.activeElement, root.querySelector("select"));
  const save = store.move("i", "doing");
  doc.querySelector("#outside").focus();
  finish("doing");
  await save;
  assert.equal(doc.activeElement, doc.querySelector("#outside"));
});

test("refresh preserves the reading position inside a long workflow column", async () => {
  const root = new JSDOM("<main></main>").window.document.querySelector("main");
  const store = new BoardStore();
  store.setClient({ load: async () => boardData(), move: async () => "doing" });
  const widget = new BoardWidget(root, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  const cards = () => root.querySelector('[data-state-id="todo"] .ldb-cards');
  assert.ok(cards(), "the card list needs its own scroll area");
  cards().scrollTop = 132;
  await store.refresh(true);
  assert.equal(cards().scrollTop, 132);
});

test("a team preference narrows a rendered board and can be cleared without reloading", async () => {
  const el = new JSDOM("<main></main>").window.document.querySelector("main");
  const data = boardData();
  data.teams.push({ ...data.teams[0], id: "design", key: "DES", name: "디자인팀" });
  data.issues.push({ ...data.issues[0], id: "des-1", identifier: "DES-1", teamId: "design" });
  const store = new BoardStore();
  store.setClient({ load: async () => data, move: async () => "todo" });
  const widget = new BoardWidget(el, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  const visible = () => Array.from(el.querySelectorAll(".ldb-lanes"), node => node.dataset.team);
  assert.deepEqual(visible(), ["team", "design"]);
  store.setTeamFilter("design");
  assert.deepEqual(visible(), ["design"]);
  assert.equal(el.querySelectorAll(".ldb-card").length, 1);
  store.setTeamFilter("no-issues");
  assert.deepEqual(visible(), []);
  assert.match(el.textContent, /선택한 팀/);
  store.setTeamFilter("");
  assert.deepEqual(visible(), ["team", "design"]);
});

test("hiding a workflow column hides its cards for that team only", async () => {
  const el = new JSDOM("<main></main>").window.document.querySelector("main");
  const data = boardData();
  data.teams.push({ ...data.teams[0], id: "design", key: "DES", name: "디자인팀" });
  data.issues.push({ ...data.issues[0], id: "des-1", identifier: "DES-1", teamId: "design" });
  const store = new BoardStore();
  store.setClient({ load: async () => data, move: async () => "todo" });
  const widget = new BoardWidget(el, store, () => {});
  store.subscribe(() => widget.render());
  await store.refresh();
  assert.equal(el.querySelectorAll('.ldb-card').length, 2);
  store.setHiddenColumns(["team/todo"]);
  assert.equal(el.querySelector('[data-team="team"] [data-state-id="todo"]'), null);
  assert.ok(el.querySelector('[data-team="team"] [data-state-id="doing"]'));
  assert.ok(el.querySelector('[data-team="design"] [data-state-id="todo"] .ldb-card'));
  store.setHiddenColumns([]);
  assert.ok(el.querySelector('[data-team="team"] [data-state-id="todo"] .ldb-card'));
});

test("activating an issue title opens the issue in the plugin without following the browser link", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  const store = new BoardStore();
  store.setClient({ load: async () => boardData(), move: async () => "todo" });
  const opened = [];
  const widget = new BoardWidget(root, store, () => {}, () => true, issue => opened.push(issue.url));
  store.subscribe(() => widget.render());
  await store.refresh();
  const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  root.querySelector(".ldb-title").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(opened, ["https://linear.app/demo/issue/DEV-3"]);
  dom.window.close();
});
