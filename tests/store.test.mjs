import assert from "node:assert/strict";
import test from "node:test";
import { BoardStore, isLiveNote } from "../src/store.ts";

function fixture() {
  const state = (id, type) => ({ id, type, name: id, position: 0, color: "#557799" });
  return {
    teams: [
      { id: "a", key: "A", name: "팀 A", states: [
        state("todo", "unstarted"), state("doing", "started"), state("done", "completed"),
        state("dup", "duplicate"),
      ] },
      { id: "b", key: "B", name: "팀 B", states: [state("b-todo", "unstarted")] },
    ],
    issues: [{ id: "issue", identifier: "A-1", title: "문서 검토", url: "https://linear.app/a/issue/A-1", teamId: "a", stateId: "todo" }],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

test("a drop moves the card immediately, waits for Linear and uses the state returned by Linear", async () => {
  const reply = deferred();
  const changes = [];
  const store = new BoardStore();
  store.setClient({ load: async () => fixture(), move: (issue, state) => { changes.push([issue, state]); return reply.promise; } });
  await store.refresh();
  const pending = store.move("issue", "doing");
  assert.equal(store.data.issues[0].stateId, "doing");
  await store.move("issue", "todo");
  await store.refresh(true);
  assert.deepEqual(changes, [["issue", "doing"]]);
  reply.resolve("done");
  await pending;
  assert.equal(store.data.issues[0].stateId, "done");
  assert.equal(store.busy, null);
});

test("a rejected change restores the card and displays an actionable failure", async () => {
  const store = new BoardStore();
  store.setClient({ load: async () => fixture(), move: async () => { throw new Error("쓰기 권한을 확인해 주세요."); } });
  await store.refresh();
  await store.move("issue", "doing");
  assert.equal(store.data.issues[0].stateId, "todo");
  assert.match(store.error, /권한/);
});

test("a lost mutation response reconciles with the real server state", async () => {
  const remote = fixture();
  const store = new BoardStore();
  store.setClient({
    load: async () => structuredClone(remote),
    move: async () => { remote.issues[0].stateId = "doing"; throw new Error("연결이 끊겼습니다."); },
  });
  await store.refresh();
  await store.move("issue", "doing");
  assert.equal(store.data.issues[0].stateId, "doing");
  assert.equal(store.error, "", "a re-read that confirms the requested move clears the network warning");
});

test("a move to another team, the current state or the system duplicate status never writes", async () => {
  const calls = [];
  const store = new BoardStore();
  store.setClient({ load: async () => fixture(), move: async (...args) => { calls.push(args); return "done"; } });
  await store.refresh();
  for (const state of ["b-todo", "missing", "todo", "dup"]) await store.move("issue", state);
  await store.move("missing", "doing");
  assert.deepEqual(calls, []);
  assert.equal(store.data.issues[0].stateId, "todo");
});

test("changing credentials during a read discards the previous account's response", async () => {
  const old = deferred();
  const store = new BoardStore();
  let disposed = false;
  store.setClient({ load: () => old.promise, move: async () => "done", dispose: () => { disposed = true; } });
  const pending = store.refresh();
  store.setClient({ load: async () => ({ teams: [], issues: [] }), move: async () => "done" });
  await store.refresh();
  old.resolve(fixture());
  await pending;
  assert.equal(disposed, true);
  assert.deepEqual(store.data, { teams: [], issues: [] });
});

test("automatic refresh shares the cache and waits out a server rate limit, including manual retries", async () => {
  let now = 200_000;
  let requests = 0;
  const store = new BoardStore(() => now);
  store.setClient({
    load: async () => {
      requests++;
      if (requests === 2) throw Object.assign(new Error("요청 한도"), { retryAfterMs: 120_000 });
      return fixture();
    },
    move: async () => "done",
  });
  await store.refresh();
  await store.refresh();
  assert.equal(requests, 1);
  await store.refresh(true);
  now += 70_000;
  await store.refresh(true);
  assert.equal(requests, 2);
  assert.match(store.error, /한도/);
  now += 51_000;
  await store.refresh();
  assert.equal(requests, 3);
  assert.equal(store.error, "");
});

test("ongoing notes only appear in today's daily note or an undated note", () => {
  const localNoon = new Date(2026, 10, 18, 12);
  assert.equal(isLiveNote("raw/notes/daily/2026-11-18.md", localNoon), true);
  assert.equal(isLiveNote("raw/notes/daily/2026-11-17.md", localNoon), false);
  assert.equal(isLiveNote("raw/notes/daily/2026-11-19.md", localNoon), false);
  assert.equal(isLiveNote("개인 보드.md", localNoon), true);
});
