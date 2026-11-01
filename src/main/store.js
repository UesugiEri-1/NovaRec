"use strict";
// 极简 JSON 持久化：设置与素材库。
const fs = require("fs");
const path = require("path");

class JsonFile {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.data = null;
  }
  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = Object.assign({}, this.defaults, parsed && typeof parsed === "object" ? parsed : {});
    } catch (e) {
      this.data = Object.assign({}, this.defaults);
    }
    return this.data;
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error("[store] save failed", this.file, e && e.message);
    }
  }
  get() {
    if (!this.data) this.load();
    return this.data;
  }
  update(patch) {
    const data = this.get();
    if (patch && typeof patch === "object") {
      Object.keys(patch).forEach(function (k) { data[k] = patch[k]; });
    }
    this.save();
    return data;
  }
}

class Library {
  constructor(file) {
    this.store = new JsonFile(file, { items: [] });
  }
  items() {
    const d = this.store.get();
    if (!Array.isArray(d.items)) d.items = [];
    return d.items.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }
  add(item) {
    const d = this.store.get();
    if (!Array.isArray(d.items)) d.items = [];
    const idx = d.items.findIndex(function (x) { return x.id === item.id; });
    if (idx >= 0) d.items[idx] = item; else d.items.push(item);
    this.store.save();
    return item;
  }
  get(id) {
    return this.items().find(function (x) { return x.id === id; }) || null;
  }
  remove(id) {
    const d = this.store.get();
    const before = d.items.length;
    d.items = d.items.filter(function (x) { return x.id !== id; });
    if (d.items.length !== before) this.store.save();
    return d.items.length !== before;
  }
}

module.exports = { JsonFile, Library };
