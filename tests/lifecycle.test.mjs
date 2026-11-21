import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const { outputFiles } = await build({
  entryPoints: [new URL("../src/main.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "cjs", external: ["obsidian"], platform: "node",
});
function pluginWith(api) {
  const entry = { exports: {} };
  Function("require", "module", "exports", outputFiles[0].text)(() => api, entry, entry.exports);
  return new entry.exports.default();
}

test("disabling the plugin releases an open note's timers and event subscriptions immediately", async () => {
  const dom = new JSDOM("<main></main>", { pretendToBeVisual: true });
  const root = dom.window.document.querySelector("main");
  root.empty = () => root.replaceChildren();
  const callbacks = new Set();
  class HostChild {
    constructor(el) { this.containerEl = el; this.cleanup = []; }
    register(fn) { this.cleanup.push(fn); }
    registerInterval(id) { this.register(() => dom.window.clearInterval(id)); }
    registerDomEvent(el, name, fn) { el.addEventListener(name, fn); this.register(() => el.removeEventListener(name, fn)); }
    registerEvent(off) { this.register(off); }
    unload() { for (const fn of this.cleanup.splice(0)) fn(); }
  }
  const processors = new Map();
  class HostPlugin {
    async loadData() { return null; }
    addSettingTab() {}
    addCommand() {}
    registerEvent() {}
    registerMarkdownCodeBlockProcessor(key, processor) { processors.set(key, processor); }
  }
  const api = { MarkdownRenderChild: HostChild, Plugin: HostPlugin, PluginSettingTab: class {}, Modal: class {} };
  const plugin = pluginWith(api);
  plugin.app = {
    secretStorage: { getSecret: () => null },
    vault: { on() {} },
    workspace: {
      getLeavesOfType: () => [],
      on(name, fn) {
        if (name === "active-leaf-change") callbacks.add(fn);
        return () => callbacks.delete(fn);
      },
    },
  };
  try {
    await plugin.onload();
    processors.get("linear-board")("", root, { sourcePath: "업무.md", addChild: child => child.onload() });
    assert.equal(callbacks.size, 1);
    plugin.onunload();
    assert.equal(callbacks.size, 0, "a rendered note must not reconnect the disabled plugin");
    assert.equal(root.querySelector("button"), null);
  } finally {
    dom.window.close();
  }
});

test("daily layout follows the file when splitting, reusing or renaming a tab, and is released on unload", async () => {
  class MarkdownView {
    constructor(path) { this.file = { path }; this.contentEl = doc.createElement("div"); }
  }
  class HostPlugin { async loadData() { return null; } addSettingTab() {} addCommand() {} registerEvent() {} registerMarkdownCodeBlockProcessor() {} }
  const doc = new JSDOM().window.document;
  const daily = "raw/notes/daily/2026-11-18.md", other = "notes/주제.md";
  const views = [new MarkdownView(daily), new MarkdownView(other)];
  const handlers = new Map();
  const on = (name, fn) => handlers.set(name, fn);
  const plugin = pluginWith({ Plugin: HostPlugin, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Modal: class {}, MarkdownView });
  plugin.app = { workspace: { on, getLeavesOfType: () => views.map(view => ({ view })) }, vault: { on }, secretStorage: { getSecret: () => null } };
  const wide = () => views.map(view => view.contentEl.classList.contains("ldb-daily-note"));
  await plugin.onload();
  assert.deepEqual(wide(), [true, false]);
  views.push(new MarkdownView(daily));
  handlers.get("layout-change")();
  assert.deepEqual(wide(), [true, false, true]);
  views[0].file = { path: other };
  handlers.get("file-open")(views[0].file);
  assert.deepEqual(wide(), [false, false, true]);
  views[1].file.path = daily;
  handlers.get("rename")(views[1].file, other);
  assert.deepEqual(wide(), [false, true, true]);
  plugin.onunload();
  assert.deepEqual(wide(), [false, false, false]);
});

test("team and workflow column settings persist together across reloads", async () => {
  const dom = new JSDOM("<main></main>");
  const root = dom.window.document.querySelector("main");
  const doc = root.ownerDocument;
  class Setting {
    constructor(el) {
      this.settingEl = doc.createElement("div");
      el.append(this.settingEl);
    }
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    addToggle(configure) {
      const checkbox = doc.createElement("input");
      checkbox.type = "checkbox";
      this.settingEl.append(checkbox);
      configure({
        toggleEl: checkbox,
        setDisabled(disabled) { checkbox.disabled = disabled; return this; },
        setValue(value) { checkbox.checked = value; return this; },
        onChange(handler) { checkbox.onchange = () => handler(checkbox.checked); return this; },
      });
    }
    addDropdown(configure) {
      const select = doc.createElement("select");
      this.settingEl.append(select);
      const dropdown = {
        addOption(value, text) { select.add(new dom.window.Option(text, value)); return this; },
        setDisabled(disabled) { select.disabled = disabled; return this; },
        setValue(value) { select.value = value; return this; },
        onChange(handler) { select.onchange = () => handler(select.value); return this; },
      };
      configure(dropdown);
    }
  }
  let saved;
  class HostPlugin {
    async loadData() { return saved; }
    async saveData(data) { saved = data; }
    addSettingTab() {}
    addCommand() {}
    registerEvent() {}
    registerMarkdownCodeBlockProcessor() {}
  }
  const api = {
    Plugin: HostPlugin, Setting, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Modal: class {},
    requestUrl: async ({ body }) => {
      const { query } = JSON.parse(body);
      const pageInfo = { hasNextPage: false };
      const data = query.includes("TeamStates")
        ? { team: { states: { nodes: [{ id: "done", name: "Done", type: "completed", position: 1, color: "#888" }], pageInfo } } }
        : { teams: { nodes: [{ id: "design", key: "DES", name: "디자인팀" }], pageInfo } };
      return { status: 200, headers: {}, text: JSON.stringify({ data }) };
    },
  };
  const app = {
    workspace: { on() {}, getLeavesOfType: () => [] },
    vault: { on() {} },
    secretStorage: { getSecret: () => "test-key" },
  };
  const start = async () => {
    const plugin = pluginWith(api);
    plugin.app = app;
    await plugin.onload();
    return plugin;
  };
  const plugin = await start();
  plugin.teamSetting(root);
  await new Promise(resolve => setImmediate(resolve));
  const select = root.querySelector("select");
  assert.deepEqual(Array.from(select.options, option => option.text), ["모든 팀", "디자인팀 (DES)"]);
  assert.equal(select.value, "");
  select.value = "design";
  await select.onchange();
  assert.equal(plugin.store.teamId, "design");
  await new Promise(resolve => setImmediate(resolve));
  const done = root.querySelector('input[type="checkbox"]');
  assert.equal(done.checked, true);
  done.checked = false;
  await done.onchange();
  const restarted = await start();
  assert.equal(restarted.store.teamId, "design");
  assert.deepEqual([...restarted.store.hiddenColumns], ["design/done"]);
  dom.window.close();
});

test("opening two issues reuses a right sidebar web viewer and leaves other tabs alone", async () => {
  const rightSplit = {};
  const plugin = pluginWith({ Plugin: class {}, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Modal: class {} });
  const tabs = [];
  const revealed = [];
  const workspace = {
    rightSplit,
    getLeavesOfType: type => tabs.filter(tab => tab.view.getViewType() === type),
    getRightLeaf: () => {
      const tab = {
        view: { getViewType: () => tab.state?.type ?? "empty" },
        getRoot: () => rightSplit,
        getViewState: () => tab.state,
        setViewState: async state => { tab.state = state; },
      };
      tabs.push(tab);
      return tab;
    },
    revealLeaf: async leaf => { revealed.push(leaf); },
  };
  const memo = workspace.getRightLeaf();
  await memo.setViewState({ type: "markdown", state: { file: "memo.md" } });
  plugin.app = { workspace };
  await plugin.openIssue({ url: "https://linear.app/team/issue/A-1", title: "First" });
  await plugin.openIssue({ url: "https://linear.app/team/issue/A-2", title: "Second" });
  assert.equal(tabs.length, 2);
  assert.equal(memo.getViewState().state.file, "memo.md");
  assert.deepEqual(revealed, [tabs[1], tabs[1]]);
  assert.equal(tabs[1].getViewState().state.url, "https://linear.app/team/issue/A-2");
});
