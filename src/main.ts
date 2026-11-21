import {
  App, MarkdownRenderChild, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, type MarkdownPostProcessorContext,
  getLanguage, moment, requestUrl, type Setting, type SettingDefinition, type SettingDefinitionItem, WorkspaceLeaf,
} from "obsidian";
import { LinearClient, type Issue, type Team, type WorkflowState } from "./linear.ts";
import { BoardStore, REFRESH_MS } from "./store.ts";
import { BoardWidget } from "./widget.ts";
import { getCurrentLanguage, setLanguage, t, type Language } from "./i18n.ts";

const WEB_VIEWER = "webviewer";
const KEY_ID = "linear-daily-board-api-key";

type DisplaySettings = { teamId: string; hiddenColumns: string[]; language: Language };
// Teams and statuses shown in the settings tab. A string is the message of a failed load; undefined is still loading.
type SettingsData = {
  client: LinearClient;
  teams?: Omit<Team, "states">[] | string;
  states: Map<string, WorkflowState[] | string>;
};
type DailyNotesOptions = { folder?: unknown; format?: unknown };
type InternalPlugins = {
  internalPlugins?: { getPluginById?(id: string): { instance?: { options?: DailyNotesOptions } } | null };
};

// Obsidian has no public API for the core Daily notes settings, so read its options directly.
function isDailyNote(app: App, path: string): boolean {
  const options = (app as App & InternalPlugins).internalPlugins?.getPluginById?.("daily-notes")?.instance?.options ?? {};
  const folder = typeof options.folder === "string" ? options.folder.replace(/^\/+|\/+$/g, "") : "";
  const format = typeof options.format === "string" && options.format ? options.format : "YYYY-MM-DD";
  const prefix = folder ? folder + "/" : "";
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return false;
  return moment(path.slice(prefix.length, -3), format, true).isValid();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
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
  private settingsData: SettingsData | null = null;

  async onload() {
    const settings = (await this.loadData() as Partial<Record<keyof DisplaySettings, unknown>> | null) ?? {};
    // Until the user picks one, follow the language Obsidian itself is set to.
    setLanguage(isLanguage(settings.language) ? settings.language
      : typeof getLanguage === "function" && getLanguage().startsWith("ko") ? "ko" : "en");
    if (typeof settings.teamId === "string") this.store.setTeamFilter(settings.teamId);
    if (Array.isArray(settings.hiddenColumns)) {
      this.store.setHiddenColumns((settings.hiddenColumns as unknown[]).filter(column => typeof column === "string"));
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

  openConnection(saved?: () => void) {
    new ConnectModal(this.app, this, saved).open();
  }

  settingDefinitions(changed: () => void): SettingDefinitionItem[] {
    this.updateKey();
    const client = this.linear;
    const items: SettingDefinitionItem[] = [{
      name: t("language"),
      desc: t("languageDesc"),
      render: setting => this.languageSetting(setting, changed),
    }];
    if (client) items.push(...this.boardDefinitions(client, changed));
    items.push({
      name: t("keyLabel"),
      desc: t("keyHelp").trim(),
      render: setting => {
        setting.addButton(button => button.setButtonText(this.key ? t("changeKey") : t("connect")).setCta().onClick(() => {
          this.openConnection(() => {
            new Notice(t("keySaved"));
            changed();
          });
        }));
      },
    });
    return items;
  }

  clearSettingsData() {
    this.settingsData = null;
  }

  private languageSetting(setting: Setting, changed: () => void) {
    setting.addDropdown(dropdown => {
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

  private boardDefinitions(client: LinearClient, changed: () => void): SettingDefinitionItem[] {
    const data = this.settingsData?.client === client ? this.settingsData : undefined;
    const teams = data?.teams;
    const team: SettingDefinition = {
      name: t("team"),
      desc: Array.isArray(teams) ? t("teamDesc") : teams ?? t("teamsLoading"),
      // Loading starts when the tab is shown, not when Obsidian indexes the definitions for search.
      render: setting => this.teamSetting(setting, this.loadSettingsData(client, changed), changed),
    };
    if (!data || !Array.isArray(teams)) return [team];
    const { teamId } = this.store;
    const visibleTeams = teamId ? teams.filter(team => team.id === teamId) : teams;
    return [team, {
      type: "group",
      heading: t("states"),
      items: visibleTeams.length === 1 ? this.stateDefinitions(data, visibleTeams[0].id)
        : visibleTeams.length ? visibleTeams.map(team => ({
          type: "page" as const, name: `${team.name} (${team.key})`, items: this.stateDefinitions(data, team.id),
        }))
        : [{ name: t("statesNoTeam"), searchable: false }],
    }];
  }

  private loadSettingsData(client: LinearClient, changed: () => void): SettingsData {
    if (this.settingsData?.client === client) return this.settingsData;
    const data: SettingsData = { client, states: new Map() };
    this.settingsData = data;
    void (async () => {
      try {
        const teams = await client.listTeams();
        await Promise.all(teams.map(async team => {
          try {
            data.states.set(team.id, await client.listStates(team.id));
          } catch (error) {
            data.states.set(team.id, errorMessage(error, t("statesFailed")));
          }
        }));
        data.teams = teams;
      } catch (error) {
        data.teams = errorMessage(error, t("teamsFailed"));
      }
      if (this.settingsData === data && this.linear === client) changed();
    })();
    return data;
  }

  private teamSetting(setting: Setting, data: SettingsData, changed: () => void) {
    const teams = Array.isArray(data.teams) ? data.teams : null;
    setting.addDropdown(dropdown => {
      dropdown.addOption("", t("allTeams"));
      if (!teams) {
        dropdown.setDisabled(true);
        return;
      }
      for (const team of teams) dropdown.addOption(team.id, `${team.name} (${team.key})`);
      if (this.store.teamId && !teams.some(team => team.id === this.store.teamId)) {
        dropdown.addOption(this.store.teamId, t("missingTeam"));
      }
      dropdown.setValue(this.store.teamId).onChange(async teamId => {
        dropdown.setDisabled(true);
        try {
          await this.saveDisplaySettings(() => ({ teamId }));
          changed();
        } catch {
          new Notice(t("teamSaveFailed"));
          dropdown.setValue(this.store.teamId).setDisabled(false);
        }
      });
    });
  }

  private stateDefinitions(data: SettingsData, teamId: string): SettingDefinition[] {
    const states = data.states.get(teamId);
    if (!Array.isArray(states)) return [{ name: states ?? t("statesLoading"), searchable: false }];
    if (!states.length) return [{ name: t("statesEmpty"), searchable: false }];
    return states.map(state => ({
      name: state.name,
      render: setting => this.stateSetting(setting, teamId + "/" + state.id, state.name),
    }));
  }

  private stateSetting(setting: Setting, column: string, name: string) {
    setting.addToggle(toggle => {
      toggle.toggleEl.setAttribute("aria-label", name);
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
  constructor(app: App, private plugin: LinearDailyBoard, private saved?: () => void) { super(app); }
  onOpen() {
    this.setTitle(t("connectTitle"));
    this.plugin.connectionForm(this.contentEl, () => {
      this.close();
      this.saved?.();
    });
  }
  onClose() { this.contentEl.empty(); }
}

class BoardSettings extends PluginSettingTab {
  constructor(app: App, private boardPlugin: LinearDailyBoard) { super(app, boardPlugin); }
  getSettingDefinitions() {
    return this.boardPlugin.settingDefinitions(() => this.update());
  }
  hide() {
    // Load teams and statuses again the next time the tab opens.
    this.boardPlugin.clearSettingsData();
    super.hide();
  }
}
