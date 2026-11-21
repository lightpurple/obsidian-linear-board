import {
  App, MarkdownRenderChild, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, type MarkdownPostProcessorContext,
  requestUrl, setIcon, Setting, TFile, WorkspaceLeaf,
} from "obsidian";
import { LinearClient, type Issue, type Team } from "./linear.ts";
import { BoardStore, isLiveNote, REFRESH_MS } from "./store.ts";
import { BoardWidget } from "./widget.ts";

const WEB_VIEWER = "webviewer";
const KEY_ID = "linear-daily-board-api-key";
const DAILY_FOLDER = "raw/notes/daily/";
const TOPIC_FOLDER = "raw/notes/ongoing";

type DisplaySettings = { teamId: string; hiddenColumns: string[] };

function isTopicPath(path: string): boolean {
  return path === TOPIC_FOLDER || path.startsWith(TOPIC_FOLDER + "/");
}

export default class LinearDailyBoard extends Plugin {
  store = new BoardStore();
  private settingsSave = Promise.resolve();
  private linear: LinearClient | null = null;
  private key: string | null = null;
  private issueViewer: WorkspaceLeaf | null = null;
  private openingIssue = false;
  private editor: WorkspaceLeaf | null = null;
  private editedNote: TFile | null = null;
  private opening = false;
  private blocks = new Set<MarkdownRenderChild>();

  async onload() {
    const settings = await this.loadData();
    if (typeof settings?.teamId === "string") this.store.setTeamFilter(settings.teamId);
    if (Array.isArray(settings?.hiddenColumns)) {
      this.store.setHiddenColumns(settings.hiddenColumns.filter((column: unknown) => typeof column === "string"));
    }
    const updateWidths = () => this.setDailyNoteWidths(true);
    this.registerEvent(this.app.workspace.on("file-open", updateWidths));
    this.registerEvent(this.app.workspace.on("layout-change", updateWidths));
    this.registerEvent(this.app.vault.on("rename", updateWidths));
    updateWidths();
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
    this.setDailyNoteWidths(false);
    for (const block of this.blocks) block.unload();
    this.key = null;
    this.linear = null;
    this.store.setClient(null);
  }

  private setDailyNoteWidths(enabled: boolean) {
    for (const { view } of this.app.workspace.getLeavesOfType("markdown")) {
      if (view instanceof MarkdownView) {
        view.contentEl.classList.toggle("ldb-daily-note", enabled && view.file?.path.startsWith(DAILY_FOLDER) === true);
      }
    }
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
    this.linear = key ? new LinearClient(key, requestUrl) : null;
    this.store.setClient(this.linear);
  }

  openConnection() {
    new ConnectModal(this.app, this).open();
  }

  teamSetting(el: HTMLElement) {
    this.updateKey();
    const client = this.linear;
    if (!client) return;
    const setting = new Setting(el).setName("표시할 팀");
    const description = "일일노트에서 선택한 팀의 내 담당 이슈를 표시합니다.";
    setting.setDesc("Linear 팀을 불러오는 중…");
    const statesEl = el.ownerDocument.createElement("div");
    el.append(statesEl);
    setting.addDropdown(dropdown => {
      dropdown.setDisabled(true).addOption("", "모든 팀");
      void client.listTeams().then(teams => {
        if (!el.contains(setting.settingEl) || this.linear !== client) return;
        for (const team of teams) dropdown.addOption(team.id, `${team.name} (${team.key})`);
        if (this.store.teamId && !teams.some(team => team.id === this.store.teamId)) {
          dropdown.addOption(this.store.teamId, "이전에 선택한 팀 (목록에 없음)");
        }
        setting.setDesc(description);
        this.renderStateSettings(statesEl, client, teams);
        dropdown.setValue(this.store.teamId).setDisabled(false).onChange(async teamId => {
          dropdown.setDisabled(true);
          try {
            await this.saveDisplaySettings(() => ({ teamId }));
            if (el.contains(statesEl) && this.linear === client) this.renderStateSettings(statesEl, client, teams);
          } catch {
            new Notice("팀 선택을 저장하지 못했습니다.");
          } finally {
            dropdown.setValue(this.store.teamId).setDisabled(false);
          }
        });
      }).catch(error => {
        if (el.contains(setting.settingEl) && this.linear === client) {
          setting.setDesc(error instanceof Error ? error.message : "Linear 팀을 불러오지 못했습니다.");
        }
      });
    });
  }

  private saveDisplaySettings(change: () => Partial<DisplaySettings>) {
    const save = this.settingsSave.then(async () => {
      const changed = change();
      await this.saveData({ teamId: this.store.teamId, hiddenColumns: [...this.store.hiddenColumns], ...changed });
      if (changed.teamId !== undefined) this.store.setTeamFilter(changed.teamId);
      if (changed.hiddenColumns !== undefined) this.store.setHiddenColumns(changed.hiddenColumns);
    });
    this.settingsSave = save.catch(() => {});
    return save;
  }

  private renderStateSettings(el: HTMLElement, client: LinearClient, teams: Omit<Team, "states">[]) {
    el.replaceChildren();
    const { teamId } = this.store;
    const visibleTeams = teamId ? teams.filter(team => team.id === teamId) : teams;
    new Setting(el).setName("표시할 상태").setHeading()
      .setDesc(visibleTeams.length ? "칸반에 표시할 상태를 켜세요." : "상태를 표시할 수 있는 팀이 없습니다.");
    const doc = el.ownerDocument;
    for (const team of visibleTeams) {
      const stateList = doc.createElement("div");
      if (visibleTeams.length === 1) {
        el.append(stateList);
        void this.loadStateSettings(stateList, client, team.id);
        continue;
      }
      const details = doc.createElement("details");
      const summary = doc.createElement("summary");
      summary.textContent = `${team.name} (${team.key})`;
      details.append(summary, stateList);
      el.append(details);
      details.ontoggle = () => {
        if (!details.open || stateList.hasChildNodes()) return;
        void this.loadStateSettings(stateList, client, team.id);
      };
    }
  }

  private async loadStateSettings(el: HTMLElement, client: LinearClient, teamId: string) {
    const status = el.ownerDocument.createElement("p");
    status.className = "ldb-hint";
    status.setAttribute("role", "status");
    status.textContent = "Linear 상태를 불러오는 중…";
    el.append(status);
    try {
      const states = await client.listStates(teamId);
      if (!el.isConnected || this.linear !== client) return;
      if (!states.length) {
        status.textContent = "이 팀에 표시할 상태가 없습니다.";
        return;
      }
      status.remove();
      for (const state of states) {
        const column = teamId + "/" + state.id;
        new Setting(el).setName(state.name).addToggle(toggle => {
          toggle.toggleEl.setAttribute("aria-label", state.name);
          toggle.setValue(!this.store.hiddenColumns.has(column)).onChange(async visible => {
            toggle.setDisabled(true);
            try {
              await this.saveDisplaySettings(() => {
                const hidden = new Set(this.store.hiddenColumns);
                if (visible) hidden.delete(column);
                else hidden.add(column);
                return { hiddenColumns: [...hidden] };
              });
            } catch {
              new Notice("상태 선택을 저장하지 못했습니다.");
            } finally {
              toggle.setValue(!this.store.hiddenColumns.has(column)).setDisabled(false);
            }
          });
        });
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Linear 상태를 불러오지 못했습니다.";
    }
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

  async openIssue(issue: Issue) {
    if (this.openingIssue || !issue.url.startsWith("https://linear.app/")) return;
    this.openingIssue = true;
    let newLeaf: WorkspaceLeaf | null = null;
    try {
      const workspace = this.app.workspace;
      const viewers = workspace.getLeavesOfType(WEB_VIEWER).filter(leaf =>
        leaf.getRoot() === workspace.rightSplit && !leaf.getViewState().pinned);
      const existing = viewers.find(leaf => leaf === this.issueViewer || leaf.getViewState().state?.url === issue.url);
      const leaf = existing ?? (newLeaf = workspace.getRightLeaf(false));
      if (!leaf) throw new Error("Right sidebar unavailable");
      await leaf.setViewState({ type: WEB_VIEWER, active: true, state: { url: issue.url, title: issue.title, navigate: true } });
      if (leaf.view.getViewType() !== WEB_VIEWER) throw new Error("Web viewer unavailable");
      await workspace.revealLeaf(leaf);
      this.issueViewer = leaf;
    } catch {
      newLeaf?.detach();
      new Notice("오른쪽에서 이슈를 열 수 없습니다. 데스크톱 옵시디언에서 코어 플러그인 ‘웹 뷰어’를 켜 주세요.");
    } finally {
      this.openingIssue = false;
    }
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
    // The board always shows current Linear state, whichever daily note it is in.
    const widget = new BoardWidget(containerEl, plugin.store, () => plugin.openConnection(), undefined,
      issue => void plugin.openIssue(issue));
    this.register(plugin.store.subscribe(() => widget.render()));
    const refresh = () => {
      if (widget.dragging || widget.selecting || containerEl.ownerDocument.hidden || !containerEl.getClientRects().length) return;
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
    this.boardPlugin.teamSetting(this.containerEl);
    this.boardPlugin.connectionForm(this.containerEl, () => {
      new Notice("API 키를 저장했습니다.");
      this.display();
    });
  }
}
