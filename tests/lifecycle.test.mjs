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
    plugin.onload();
    processors.get("linear-board")("", root, { sourcePath: "업무.md", addChild: child => child.onload() });
    assert.equal(callbacks.size, 1);
    plugin.onunload();
    assert.equal(callbacks.size, 0, "a rendered note must not reconnect the disabled plugin");
    assert.equal(root.querySelector("button"), null);
  } finally {
    dom.window.close();
  }
});

test("daily layout follows the file when splitting, reusing or renaming a tab, and is released on unload", () => {
  class MarkdownView {
    constructor(path) { this.file = { path }; this.contentEl = doc.createElement("div"); }
  }
  class HostPlugin { addSettingTab() {} addCommand() {} registerEvent() {} registerMarkdownCodeBlockProcessor() {} }
  const doc = new JSDOM().window.document;
  const daily = "raw/notes/daily/2026-11-18.md", topic = "raw/notes/ongoing/주제.md";
  const views = [new MarkdownView(daily), new MarkdownView(topic)];
  const handlers = new Map();
  const on = (name, fn) => handlers.set(name, fn);
  const plugin = pluginWith({ Plugin: HostPlugin, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Modal: class {}, MarkdownView });
  plugin.app = { workspace: { on, getLeavesOfType: () => views.map(view => ({ view })) }, vault: { on }, secretStorage: { getSecret: () => null } };
  const wide = () => views.map(view => view.contentEl.classList.contains("ldb-daily-note"));
  plugin.onload();
  assert.deepEqual(wide(), [true, false]);
  views.push(new MarkdownView(daily));
  handlers.get("layout-change")();
  assert.deepEqual(wide(), [true, false, true]);
  views[0].file = { path: topic };
  handlers.get("file-open")(views[0].file);
  assert.deepEqual(wide(), [false, false, true]);
  views[1].file.path = daily;
  handlers.get("rename")(views[1].file, topic);
  assert.deepEqual(wide(), [false, true, true]);
  plugin.onunload();
  assert.deepEqual(wide(), [false, false, false]);
});

test("clicking a topic after restarting Obsidian reuses its unpinned editor in the right sidebar", async () => {
  class MarkdownView {}
  const plugin = pluginWith({ Plugin: class {}, MarkdownRenderChild: class {}, PluginSettingTab: class {}, Modal: class {}, MarkdownView });
  const rightSplit = {};
  const file = { path: "raw/notes/ongoing/주제.md" };
  const restored = {
    view: Object.assign(new MarkdownView(), { file }),
    getRoot: () => rightSplit, getViewState: () => ({ pinned: false }),
    openFile: async () => {}, detach() {},
  };
  let extraTabs = 0;
  const workspace = {
    rightSplit, getLeavesOfType: () => [restored], revealLeaf: async () => {},
    getRightLeaf: () => { extraTabs++; return { openFile: async () => {} }; },
  };
  plugin.app = { workspace };
  await plugin.openTopic(file);
  assert.equal(extraTabs, 0);
  assert.equal(plugin.topicEditor(), restored);
});
