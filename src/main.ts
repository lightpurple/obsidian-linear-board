import {
  App, MarkdownRenderChild, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, type MarkdownPostProcessorContext,
  getLanguage, moment, requestUrl, Setting, WorkspaceLeaf,
} from "obsidian";
import { LinearClient, type Issue, type Team } from "./linear.ts";
import { BoardStore, REFRESH_MS } from "./store.ts";
import { BoardWidget } from "./widget.ts";
import { getCurrentLanguage, setLanguage, t, type Language } from "./i18n.ts";

const WEB_VIEWER = "webviewer";
const KEY_ID = "linear-daily-board-api-key";

type DisplaySettings = { teamId: string; hiddenColumns: string[]; language: Language };

// Obsidian has no public API for the core Daily notes settings, so read its options directly.
function isDailyNote(app: App, path: string): boolean {
  const options = (app as any).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options ?? {};
  const folder = String(options.folder ?? "").replace(/^\/+|\/+$/g, "");
  const prefix = folder ? folder + "/" : "";
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return false;
  return moment(path.slice(prefix.length, -3), options.format || "YYYY-MM-DD", true).isValid();
}

function isLanguage(value: unknown): value is Language {
  return value === "ko" || value === "en";
}

export default class LinearDailyBoard extends Plugin {
  store = new BoardStore();
  private settingsSave = Promise.resolve();
  private linear: LinearClient | null = null;
  private key: string | null = null;
  private issueViewer: WorkspaceLeaf | null = null;
  private openingIssue = false;
  private blocks = new Set<MarkdownRenderChild>();

  async onload() {
    const settings = await this.loadData();
    // Until the user picks one, follow the language Obsidian itself is set to.
    setLanguage(isLanguage(settings?.language) ? settings.language
      : typeof getLanguage === "function" && getLanguage().startsWith("ko") ? "ko" : "en");
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
    this.addCommand({ id: "connect", name: t("connectCommand"), callback: () => this.openConnection() });
    this.registerMarkdownCodeBlockProcessor("linear-board", (_text, el, ctx) => {
      this.mount(ctx, new LiveBoard(el, this, ctx.sourcePath));
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
        view.contentEl.classList.toggle("ldb-daily-note", enabled && !!view.file && isDailyNote(this.app, view.file.path));
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

  languageSetting(el: HTMLElement, changed: () => void) {
    new Setting(el).setName(t("language")).setDesc(t("languageDesc")).addDropdown(dropdown => {
      dropdown.addOption("ko", "한국어").addOption("en", "English").setValue(getCurrentLanguage()).onChange(async value => {
        if (!isLanguage(value)) return;
        try {
          await this.saveDisplaySettings(() => ({ language: value }));
          changed();
        } catch {
          new Notice(t("languageSaveFailed"));
          dropdown.setValue(getCurrentLanguage());
        }
      });
    });
  }

  teamSetting(el: HTMLElement) {
    this.updateKey();
    const client = this.linear;
    if (!client) return;
    const setting = new Setting(el).setName(t("team"));
    const description = t("teamDesc");
    setting.setDesc(t("teamsLoading"));
    const statesEl = el.ownerDocument.createElement("div");
    el.append(statesEl);
    setting.addDropdown(dropdown => {
      dropdown.setDisabled(true).addOption("", t("allTeams"));
      void client.listTeams().then(teams => {
        if (!el.contains(setting.settingEl) || this.linear !== client) return;
        for (const team of teams) dropdown.addOption(team.id, `${team.name} (${team.key})`);
        if (this.store.teamId && !teams.some(team => team.id === this.store.teamId)) {
          dropdown.addOption(this.store.teamId, t("missingTeam"));
        }
        setting.setDesc(description);
        this.renderStateSettings(statesEl, client, teams);
        dropdown.setValue(this.store.teamId).setDisabled(false).onChange(async teamId => {
          dropdown.setDisabled(true);
          try {
            await this.saveDisplaySettings(() => ({ teamId }));
            if (el.contains(statesEl) && this.linear === client) this.renderStateSettings(statesEl, client, teams);
          } catch {
            new Notice(t("teamSaveFailed"));
          } finally {
            dropdown.setValue(this.store.teamId).setDisabled(false);
          }
        });
      }).catch(error => {
        if (el.contains(setting.settingEl) && this.linear === client) {
          setting.setDesc(error instanceof Error ? error.message : t("teamsFailed"));
        }
      });
    });
  }

  private saveDisplaySettings(change: () => Partial<DisplaySettings>) {
    const save = this.settingsSave.then(async () => {
      const changed = change();
      await this.saveData({
        teamId: this.store.teamId, hiddenColumns: [...this.store.hiddenColumns], language: getCurrentLanguage(), ...changed,
      });
      if (changed.language !== undefined) {
        setLanguage(changed.language);
        this.store.notify();
      }
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
    new Setting(el).setName(t("states")).setHeading()
      .setDesc(visibleTeams.length ? t("statesDesc") : t("statesNoTeam"));
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
    status.textContent = t("statesLoading");
    el.append(status);
    try {
      const states = await client.listStates(teamId);
      if (!el.isConnected || this.linear !== client) return;
      if (!states.length) {
        status.textContent = t("statesEmpty");
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
              new Notice(t("stateSaveFailed"));
            } finally {
              toggle.setValue(!this.store.hiddenColumns.has(column)).setDisabled(false);
            }
          });
        });
      }
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : t("statesFailed");
    }
  }

  connectionForm(el: HTMLElement, saved: () => void) {
    const form = el.createEl("form", { cls: "ldb-credentials" });
    const label = form.createEl("label");
    label.createSpan({ text: t("keyLabel") });
    const input = label.createEl("input", { type: "password", placeholder: "lin_api_…" });
    input.required = true;
    input.autocomplete = "off";
    input.spellcheck = false;
    const help = form.createEl("p", { cls: "ldb-hint" });
    help.appendText(t("keyHelp"));
    const link = help.createEl("a", { text: t("keyHelpLink"), href: "https://linear.app/developers/graphql#personal-api-keys" });
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    form.createEl("button", { type: "submit", cls: "mod-cta", text: this.key ? t("changeKey") : t("connect") });
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
        new Notice(t("keySaveFailed"));
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
      new Notice(t("issueViewerFailed"));
    } finally {
      this.openingIssue = false;
    }
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

class ConnectModal extends Modal {
  constructor(app: App, private plugin: LinearDailyBoard) { super(app); }
  onOpen() {
    this.setTitle(t("connectTitle"));
    this.plugin.connectionForm(this.contentEl, () => this.close());
  }
  onClose() { this.contentEl.empty(); }
}

class BoardSettings extends PluginSettingTab {
  constructor(app: App, private boardPlugin: LinearDailyBoard) { super(app, boardPlugin); }
  display() {
    this.containerEl.empty();
    this.boardPlugin.languageSetting(this.containerEl, () => this.display());
    this.boardPlugin.teamSetting(this.containerEl);
    this.boardPlugin.connectionForm(this.containerEl, () => {
      new Notice(t("keySaved"));
      this.display();
    });
  }
}
