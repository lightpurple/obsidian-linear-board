import assert from "node:assert/strict";
import test from "node:test";
import { LinearClient } from "../src/linear.ts";

const apiKey = "fixture-api-key";
const engineering = { id: "team-e", key: "ENG", name: "Engineering" };
const design = { id: "team-d", key: "DES", name: "Design" };

function requestFixture(handler, key = apiKey) {
  const requests = [];
  const client = new LinearClient(key, async (request) => {
    const body = JSON.parse(request.body);
    requests.push({ ...request, ...body });
    return handler(body);
  });
  return { client, requests };
}

function response(body, status = 200, headers = {}) {
  return { status, text: JSON.stringify(body), headers };
}

function page(nodes, endCursor = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function assigned(nodes, endCursor = null) {
  return response({ data: { viewer: { assignedIssues: page(nodes, endCursor) } } });
}

function states(nodes, endCursor = null) {
  return response({ data: { team: { states: page(nodes, endCursor) } } });
}

function issue(number, team, stateId) {
  const identifier = `${team.key}-${number}`;
  return {
    id: `issue-${number}`,
    identifier,
    title: `Title ${number}`,
    url: `https://linear.app/example/issue/${identifier}`,
    state: { id: stateId },
    team,
  };
}

function state(id, type, position) {
  return { id, name: id, type, position, color: "#447799" };
}

test("loads every assigned-issue and team-status page, including empty columns, in Linear workflow order", async () => {
  const { client, requests } = requestFixture(({ query, variables }) => {
    if (query.includes("assignedIssues")) {
      return variables.after
        ? assigned([issue(2, engineering, "done"), issue(3, design, "todo-d"), issue(4, engineering, "todo-e")])
        : assigned([issue(1, engineering, "todo-e"), issue(2, engineering, "done")], "issues-next");
    }
    if (variables.teamId === design.id) return states([state("todo-d", "unstarted", 0)]);
    if (variables.teamId === engineering.id && !variables.after) {
      return states([
        state("done", "completed", -10),
        state("review", "started", 0.8),
        state("backlog", "backlog", 99),
        state("duplicate", "duplicate", 0),
      ], "states-next");
    }
    return states([
      state("review", "started", 0.8),
      state("canceled", "canceled", -1),
      state("triage", "triage", 10),
      state("build", "started", 0.1),
      state("todo-e", "unstarted", 5),
    ]);
  });

  const board = await client.load();
  assert.deepEqual(board.issues.map(({ id }) => id), ["issue-1", "issue-2", "issue-3", "issue-4"]);
  assert.deepEqual(board.issues[2], {
    id: "issue-3", identifier: "DES-3", title: "Title 3",
    url: "https://linear.app/example/issue/DES-3", teamId: design.id, stateId: "todo-d",
  });
  assert.deepEqual(board.teams.find(({ id }) => id === design.id), {
    ...design, states: [state("todo-d", "unstarted", 0)],
  });
  assert.deepEqual(board.teams.find(({ id }) => id === engineering.id).states.map(({ id }) => id),
    ["triage", "backlog", "todo-e", "build", "review", "done", "canceled", "duplicate"]);
  assert.equal(board.teams.length, 2);

  const issuePages = requests.filter(({ query }) => query.includes("assignedIssues"));
  assert.deepEqual(issuePages.map(({ variables }) => variables.after ?? null), [null, "issues-next"]);
  assert.match(issuePages[0].query, /viewer\s*\{\s*assignedIssues\s*\([^)]*includeArchived:\s*false/s);
  const statePages = requests.filter(({ query }) => /\bteam\s*\(/.test(query));
  assert.deepEqual(statePages.filter(({ variables }) => variables.teamId === engineering.id)
    .map(({ variables }) => variables.after ?? null), [null, "states-next"]);
  assert.equal(statePages.filter(({ variables }) => variables.teamId === design.id).length, 1);
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.url, "https://api.linear.app/graphql");
    assert.equal(request.method, "POST");
    assert.equal(request.throw, false);
    assert.equal(request.headers.Authorization, apiKey);
    assert.equal(request.headers["Content-Type"], "application/json");
    assert.ok(!request.body.includes(apiKey));
  }
});

test("an empty assigned list completes without requesting another team's statuses", async () => {
  const { client, requests } = requestFixture(() => assigned([]));
  assert.deepEqual(await client.load(), { teams: [], issues: [] });
  assert.equal(requests.length, 1);
});

test("disposing during a read prevents further page and team requests with the old key", async () => {
  for (const after of ["next-page", null]) {
    const pending = Promise.withResolvers();
    const { client, requests } = requestFixture(() => pending.promise);
    const loading = client.load();
    assert.equal(requests.length, 1);
    client.dispose();
    pending.resolve(assigned([issue(1, engineering, "todo")], after));
    await assert.rejects(loading, /종료/);
    await assert.rejects(client.load(), /종료/);
    assert.equal(requests.length, 1);
  }
});

test("disposing discards a pending mutation's result and blocks new writes", async () => {
  const pending = Promise.withResolvers();
  const { client, requests } = requestFixture(() => pending.promise);
  const moving = client.move("issue-1", "requested");
  assert.equal(requests.length, 1);
  client.dispose();
  pending.resolve(response({ data: { issueUpdate: {
    success: true, issue: { id: "issue-1", state: { id: "requested" } },
  } } }));
  await assert.rejects(moving, /종료/);
  await assert.rejects(client.move("issue-1", "another"), /종료/);
  assert.equal(requests.length, 1);
});

test("a state move writes only the state and returns the state confirmed for that issue", async () => {
  const { client, requests } = requestFixture(() =>
    response({ data: { issueUpdate: { success: true, issue: { id: "issue-1", state: { id: "confirmed" } } } } }));
  assert.equal(await client.move("issue-1", "requested"), "confirmed");
  assert.deepEqual(requests[0].variables, { issueId: "issue-1", stateId: "requested" });
  assert.match(requests[0].query, /issueUpdate\s*\(\s*id:\s*\$issueId\s*,?\s*input:\s*\{\s*stateId:\s*\$stateId\s*\}\s*\)/);
  assert.equal(requests.length, 1);
});

test("a failed or unconfirmed mutation never reports a successful move", async () => {
  for (const payload of [
    { success: false, issue: { id: "issue-1", state: { id: "s" } } },
    { success: true, issue: null },
    { success: true, issue: { id: "another-issue", state: { id: "s" } } },
    { success: true, issue: { id: "issue-1", state: null } },
  ]) {
    const { client, requests } = requestFixture(() => response({ data: { issueUpdate: payload } }));
    await assert.rejects(client.move("issue-1", "s"), /상태|응답/);
    assert.equal(requests.length, 1);
  }
});

test("partial GraphQL errors invalidate HTTP 200 data and redact the upstream message", async () => {
  const { client } = requestFixture(() => response({
    data: { viewer: { assignedIssues: page([]) } },
    errors: [{ message: "private upstream detail: " + apiKey }],
  }));
  await assert.rejects(client.load(), (error) => {
    assert.match(error.message, /Linear/);
    assert.doesNotMatch(error.message, /fixture-api-key|private upstream/);
    return true;
  });
});

test("authentication and access failures give actionable errors without exposing request details", async () => {
  for (const [status, extensions, expected] of [
    [401, {}, /API 키|인증/],
    [403, {}, /권한/],
    [200, { type: "authentication error" }, /API 키|인증/],
    [200, { code: "FORBIDDEN" }, /권한/],
  ]) {
    const { client } = requestFixture(() => response({ errors: [{ message: apiKey, extensions }] }, status));
    await assert.rejects(client.load(), (error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
  const { client, requests } = requestFixture(() => assigned([]), "   ");
  await assert.rejects(client.load(), /API 키/);
  assert.equal(requests.length, 0);
});

test("rate limits carry the server's retry delay even when reported as a GraphQL error", async () => {
  for (const [status, extensions, headers, minMs, maxMs] of [
    [429, {}, { "Retry-After": "15" }, 15_000, 15_000],
    [400, { code: "RATELIMITED" }, { "retry-after": "42" }, 42_000, 42_000],
    [200, { type: "ratelimited" }, { "X-RateLimit-Requests-Reset": String(Date.now() + 30_000) }, 28_000, 30_000],
    [429, {}, {}, 1_000, 300_000],
  ]) {
    const { client } = requestFixture(() => response({ errors: [{ extensions }] }, status, headers));
    await assert.rejects(client.load(), (error) => {
      assert.match(error.message, /요청.*(?:한도|제한)|요청이 너무/);
      assert.ok(error.retryAfterMs >= minMs && error.retryAfterMs <= maxMs);
      return true;
    });
  }
});

test("an exhausted endpoint or complexity quota uses its own reset and ignores healthy quotas", async () => {
  const now = Date.now();
  for (const [complexityRemaining, expectedDelay] of [["20", 15_000], ["0", 30_000]]) {
    const { client } = requestFixture(() => response({}, 429, {
      "X-RateLimit-Requests-Remaining": "1500",
      "X-RateLimit-Requests-Reset": String(now + 3_600_000),
      "X-RateLimit-Endpoint-Requests-Remaining": "0",
      "X-RateLimit-Endpoint-Requests-Reset": String(now + 15_000),
      "X-RateLimit-Complexity-Remaining": complexityRemaining,
      "X-RateLimit-Complexity-Reset": String(now + 30_000),
    }));
    await assert.rejects(client.load(), (error) => {
      assert.ok(error.retryAfterMs <= expectedDelay && error.retryAfterMs >= now + expectedDelay - Date.now());
      return true;
    });
  }
});

test("rejects a missing or cycling page cursor without looping", async () => {
  for (const cursors of [[null], ["a", "b", "a"]]) {
    let index = 0;
    const { client, requests } = requestFixture(() => {
      if (index >= cursors.length) return assigned([]);
      return response({ data: { viewer: { assignedIssues: {
        nodes: [], pageInfo: { hasNextPage: true, endCursor: cursors[index++] },
      } } } });
    });
    await assert.rejects(client.load(), /페이지|응답/);
    assert.equal(requests.length, cursors.length);
  }
});

test("transport and malformed responses produce Korean errors without copying private content", async () => {
  for (const handler of [
    () => { throw new Error("transport included " + apiKey); },
    () => ({ text: "invalid JSON: " + apiKey, status: 200, headers: {} }),
    () => response({ data: { viewer: { assignedIssues: { nodes: [], pageInfo: {} } } } }),
    () => assigned([{ ...issue(1, engineering, "todo"), state: null }]),
  ]) {
    const { client } = requestFixture(handler);
    await assert.rejects(client.load(), (error) => {
      assert.match(error.message, /[가-힣]/u);
      assert.ok(!error.message.includes(apiKey));
      return true;
    });
  }
});

test("a status removed between issue and team requests cannot silently hide an assigned card", async () => {
  const { client } = requestFixture(({ query }) => query.includes("assignedIssues")
    ? assigned([issue(1, engineering, "removed")])
    : states([state("todo", "unstarted", 0)]));
  await assert.rejects(client.load(), /상태.*새로/);
});

test("lists accessible teams even when the user has no issues in those teams", async () => {
  const { client } = requestFixture(({ query, variables }) => {
    assert.match(query, /teams\(.*after: \$after/);
    return response({ data: { teams: variables.after ? page([design]) : page([engineering], "next") } });
  });
  assert.deepEqual(await client.listTeams(), [design, engineering]);
});
