import {
  App, MarkdownRenderChild, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, type MarkdownPostProcessorContext,
  requestUrl, setIcon, TFile, WorkspaceLeaf,
} from "obsidian";
import { LinearClient } from "./linear.ts";
import { BoardStore, isLiveNote, REFRESH_MS } from "./store.ts";
import { BoardWidget } from "./widget.ts";

const KEY_ID = "linear-daily-board-api-key";
const TOPIC_FOLDER = "raw/notes/ongoing";

function isTopicPath(path: string): boolean {
  return path === TOPIC_FOLDER || path.startsWith(TOPIC_FOLDER + "/");
}

export default class LinearDailyBoard extends Plugin {
  store = new BoardStore();
  private key: string | null = null;
  private editor: WorkspaceLeaf | null = null;
  private editedNote: TFile | null = null;
  private opening = false;
  private blocks = new Set<MarkdownRenderChild>();

  onload() {
    this.addSettingTab(new BoardSettings(this.app, this));
    this.addCommand({ id: "connect", name: "Linear API 키 연결", callback: () => this.openConnection() });
    this.registerMarkdownCodeBlockProcessor("linear-board", (_text, el, ctx) => {
      this.mount(ctx, new LiveBoard(el, this, ctx.sourcePath));
    });
    this.registerMarkdownCodeBlockProcessor("ongoing-notes", (_text, el, ctx) => {
      this.mount(ctx, new TopicNotes(el, this, ctx.sourcePath));
    });
    this.updateKey();
  }

  onunload() {
    for (const block of this.blocks) block.unload();
    this.key = null;
    this.store.setClient(null);
  }

  private mount(ctx: MarkdownPostProcessorContext, block: MarkdownRenderChild) {
    this.blocks.add(block);
    block.register(() => {
      this.blocks.delete(block);
      block.containerEl.empty();
    });
    ctx.addChild(block);
  }

  updateKey() {
    const key = this.app.secretStorage.getSecret(KEY_ID)?.trim() || null;
    if (key === this.key) return;
    this.key = key;
    this.store.setClient(key ? new LinearClient(key, requestUrl) : null);
  }

  openConnection() {
    new ConnectModal(this.app, this).open();
  }

  connectionForm(el: HTMLElement, saved: () => void) {
    const form = el.createEl("form", { cls: "ldb-credentials" });
    const label = form.createEl("label");
    label.createSpan({ text: "Linear 개인 API 키" });
    const input = label.createEl("input", { type: "password", placeholder: "lin_api_…" });
    input.required = true;
    input.autocomplete = "off";
    input.spellcheck = false;
    const help = form.createEl("p", { cls: "ldb-hint" });
    help.appendText("이슈 읽기와 수정 권한이 있는 키를 입력하세요. 키는 옵시디언의 비밀 저장소에 보관합니다. ");
    const link = help.createEl("a", { text: "Linear API 키 안내", href: "https://linear.app/developers/graphql#personal-api-keys" });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    form.createEl("button", { type: "submit", cls: "mod-cta", text: this.key ? "키 변경" : "연결" });
    form.onsubmit = event => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) { input.focus(); return; }
      try {
        this.app.secretStorage.setSecret(KEY_ID, key);
        input.value = "";
        this.updateKey();
        void this.store.refresh(true);
        saved();
      } catch {
        new Notice("옵시디언 비밀 저장소에 키를 저장하지 못했습니다.");
      }
    };
  }

  topicEditor(): WorkspaceLeaf | null {
    const leaf = this.editor;
    if (!leaf || !this.app.workspace.getLeavesOfType("markdown").includes(leaf)) return null;
    if (!(leaf.view instanceof MarkdownView) || leaf.view.file !== this.editedNote || leaf.getViewState().pinned) return null;
    return leaf;
  }

  async openTopic(file: TFile) {
    if (this.opening) return;
    this.opening = true;
    try {
      const workspace = this.app.workspace;
      const restored = workspace.getLeavesOfType("markdown").find(leaf =>
        leaf.getRoot() === workspace.rightSplit && !leaf.getViewState().pinned &&
        leaf.view instanceof MarkdownView && leaf.view.file === file);
      const leaf = restored ?? this.topicEditor() ?? workspace.getRightLeaf(false) ?? workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true, state: { mode: "source" } });
      this.editor = leaf;
      this.editedNote = file;
      await workspace.revealLeaf(leaf);
    } catch {
      new Notice("메모를 열 수 없습니다. 파일이 이동했는지 확인해 주세요.");
    } finally {
      this.opening = false;
    }
  }

  closeTopic() {
    this.topicEditor()?.detach();
    this.editor = null;
    this.editedNote = null;
  }
}

class DailyBlock extends MarkdownRenderChild {
  constructor(el: HTMLElement, protected plugin: LinearDailyBoard, protected path: string) { super(el); }

  protected watchClock(callback: () => void) {
    const win = this.containerEl.ownerDocument.defaultView ?? window;
    this.registerInterval(win.setInterval(callback, REFRESH_MS));
    this.registerDomEvent(win, "focus", callback);
    this.registerDomEvent(this.containerEl.ownerDocument, "visibilitychange", callback);
  }
}

class LiveBoard extends DailyBlock {

  onload() {
    const { plugin, containerEl } = this;
    const isLive = () => isLiveNote(this.path);
    let wasLive = isLive();
    const widget = new BoardWidget(containerEl, plugin.store, () => plugin.openConnection(), isLive);
    this.register(plugin.store.subscribe(() => widget.render()));
    const refresh = () => {
      const live = isLive();
      if (wasLive !== live) { wasLive = live; widget.render(); }
      if (!live || widget.dragging || widget.selecting || containerEl.ownerDocument.hidden || !containerEl.getClientRects().length) return;
      plugin.updateKey();
      void plugin.store.refresh();
    };
    const win = containerEl.ownerDocument.defaultView ?? window;
    this.watchClock(refresh);
    this.registerEvent(plugin.app.workspace.on("active-leaf-change", refresh));
    widget.render();
    // Live Preview can mount this component before its element has a layout box.
    const frame = win.requestAnimationFrame(refresh);
    this.register(() => win.cancelAnimationFrame(frame));
  }
}

class TopicNotes extends DailyBlock {
  onload() {
    const { plugin, containerEl } = this;
    const { vault, workspace } = plugin.app;
    const render = () => {
      containerEl.empty();
      if (!isLiveNote(this.path)) return;
      const files = vault.getMarkdownFiles().filter(file => isTopicPath(file.path));
      files.sort((a, b) => a.basename.localeCompare(b.basename, "ko"));
      const list = containerEl.createEl("ul", { cls: "ldb-notes" });
      for (const file of files) {
        const item = list.createEl("li");
        const button = item.createEl("button", { cls: "ldb-open-note" });
        button.createSpan({ text: file.basename });
        setIcon(button.createSpan({ cls: "ldb-note-icon" }), "panel-right-open");
        button.title = "오른쪽에서 편집";
        button.onclick = async () => {
          if (isLiveNote(this.path)) await plugin.openTopic(file);
          updateClose();
        };
      }
      if (!files.length) containerEl.createEl("p", { cls: "ldb-hint", text: TOPIC_FOLDER + "에 추가한 메모가 여기에 표시됩니다." });
      const close = containerEl.createEl("button", { cls: "ldb-close-note", text: "열어 둔 메모 닫기" });
      close.onclick = () => { plugin.closeTopic(); updateClose(); };
      updateClose();
    };
    const updateClose = () => {
      const close = containerEl.querySelector<HTMLButtonElement>(".ldb-close-note");
      if (close) close.hidden = !plugin.topicEditor();
    };
    this.registerEvent(vault.on("create", file => { if (isTopicPath(file.path)) render(); }));
    this.registerEvent(vault.on("delete", file => { if (isTopicPath(file.path)) render(); }));
    this.registerEvent(vault.on("rename", (file, old) => { if (isTopicPath(file.path) || isTopicPath(old)) render(); }));
    this.registerEvent(workspace.on("layout-change", updateClose));
    let wasLive = isLiveNote(this.path);
    this.watchClock(() => {
      const live = isLiveNote(this.path);
      if (wasLive !== live) { wasLive = live; render(); }
    });
    render();
  }
}

class ConnectModal extends Modal {
  constructor(app: App, private plugin: LinearDailyBoard) { super(app); }
  onOpen() {
    this.setTitle("Linear 연결");
    this.plugin.connectionForm(this.contentEl, () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

class BoardSettings extends PluginSettingTab {
  constructor(app: App, private boardPlugin: LinearDailyBoard) { super(app, boardPlugin); }
  display() {
    this.containerEl.empty();
    this.boardPlugin.connectionForm(this.containerEl, () => {
      new Notice("API 키를 저장했습니다.");
      this.display();
    });
  }
}
