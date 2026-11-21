import { JSDOM as BaseJSDOM } from "jsdom";

// Obsidian adds DOM helpers such as createEl() to every element. Add the ones the plugin uses.
export class JSDOM extends BaseJSDOM {
  constructor(...args) {
    super(...args);
    const proto = this.window.HTMLElement.prototype;
    proto.createEl = function (tag, info = {}) {
      const el = this.ownerDocument.createElement(tag);
      if (info.cls) el.className = [info.cls].flat().join(" ");
      if (info.text !== undefined) el.textContent = info.text;
      for (const key of ["type", "placeholder", "href", "value", "title"]) {
        if (info[key] !== undefined) el.setAttribute(key, info[key]);
      }
      for (const [key, value] of Object.entries(info.attr ?? {})) el.setAttribute(key, value);
      this.append(el);
      return el;
    };
    proto.createDiv = function (info) { return this.createEl("div", info); };
    proto.createSpan = function (info) { return this.createEl("span", info); };
  }
}
