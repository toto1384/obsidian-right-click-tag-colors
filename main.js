// Right-Click Tag Colors: right-click a tag anywhere to give it a color (a palette color, or a custom one).
// Colors and the palette are editable in the plugin settings. Plain JavaScript, no build step.
//
// - Right-click on a rendered tag (reading view, Tasks query results, Dataview output, a tag pill in
//   Properties or Bases): opens this plugin's menu. In the editor (Live Preview / source) Obsidian already opens
//   its own menu, so the item is added to that one ("editor-menu") instead of opening a second menu.
// - Editor tags are drawn as two spans ("#" and the name) whose class drops "/" and other characters, so the
//   name is not read from the DOM: the click position is turned into a character and the tag is found in the
//   line text (tagAtClick).
// - Colors are one generated <style> per window (main and popouts), built from the settings. Rules are
//   !important so they win over automatic tag-coloring plugins such as Colored Tags, which keep coloring every
//   tag that has no color here. In the editor, Colored Tags' exact `colored-tag-<name>` class is used first,
//   with Obsidian's own `cm-tag-<name without "/">` class as a fallback. Tag pills in Properties and Bases
//   have no tag name in their markup, so the plugin marks them itself (watchPills).

const { Plugin, Menu, Modal, PluginSettingTab, Setting } = require("obsidian");
const { EditorView } = require("@codemirror/view");

const DEFAULT_PALETTE = ["#e5534b", "#f0883e", "#d4a72c", "#57ab5a", "#2f9e8f", "#4fa3e0", "#6e7ff3", "#986ee2", "#d16bb5", "#a0714f", "#8b949e", "#4a5058"];

// Characters Obsidian doesn't allow in a tag; everything else (letters, digits, _ - /, emoji) is allowed
const TAG_RE = /#[^\s#!"$%&'()*+,.:;<=>?@^`{|}~\[\]\\]+/gu;
const TAG_PROPERTY_PILLS = ['.metadata-property[data-property-key="tags" i]', '.bases-metadata-value[data-property-type="tags" i]'];

const normalizeTag = (tag) => String(tag || "").replace(/^#/, "").trim().toLowerCase();
const cssString = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Dark or light text, whichever reads better on the background (WCAG relative luminance)
function textColorFor(hex) {
	const n = parseInt(hex.slice(1), 16);
	const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
	const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	return l > 0.179 ? "#1b1b1b" : "#ffffff";
}

// The tag at the clicked spot of an editor, or null
function tagAtClick(evt) {
	const editorEl = evt.target.closest(".cm-editor");
	const view = editorEl && EditorView.findFromDOM(editorEl);
	if (!view) return null;
	const pos = view.posAtCoords({ x: evt.clientX, y: evt.clientY });
	if (pos == null) return null;
	const line = view.state.doc.lineAt(pos);
	const offset = pos - line.from;
	for (const m of line.text.matchAll(TAG_RE)) {
		if (offset >= m.index && offset <= m.index + m[0].length && !/^#\d+$/.test(m[0])) return m[0];
	}
	return null;
}

// The tag of a rendered element (a tag link or a tag pill in Properties / Bases), or null
function renderedTagAt(el) {
	const link = el.closest("a.tag");
	if (link) return link.dataset.tagName || link.getAttribute("href") || link.textContent;
	const pill = el.closest(TAG_PROPERTY_PILLS.map((p) => `${p} .multi-select-pill`).join(","));
	return pill ? pill.querySelector(".multi-select-pill-content")?.textContent || pill.textContent : null;
}

module.exports = class RightClickTagColorsPlugin extends Plugin {
	async onload() {
		const data = (await this.loadData()) || {};
		this.settings = {
			palette: Array.isArray(data.palette) ? data.palette : [...DEFAULT_PALETTE],
			tags: Object.assign({}, data.tags),
		};
		this.styleEls = new Map(); // document -> its <style>
		this.editorTag = null;
		this.addSettingTab(new TagColorsSettingTab(this.app, this));

		this.attachTo(document);
		this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.attachTo(win.document)));
		this.registerEvent(this.app.workspace.on("window-close", (_, win) => {
			this.styleEls.get(win.document)?.remove();
			this.styleEls.delete(win.document);
		}));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu) => {
			if (this.editorTag) this.addMenuItems(menu, this.editorTag);
			this.editorTag = null;
		}));
	}

	onunload() {
		for (const el of this.styleEls.values()) el.remove();
		this.styleEls.clear();
	}

	// Colors, pill marking and right-click handling for one window's document
	attachTo(doc) {
		const styleEl = doc.head.createEl("style", { attr: { id: "right-click-tag-colors" } });
		styleEl.textContent = this.buildCss();
		this.styleEls.set(doc, styleEl);
		this.watchPills(doc);
		// Capture phase: runs before Obsidian builds its editor menu, and before other handlers of rendered tags
		this.registerDomEvent(doc, "contextmenu", (evt) => {
			const target = evt.target instanceof doc.defaultView.Element ? evt.target : null;
			this.editorTag = target?.closest(".cm-hashtag") ? tagAtClick(evt) : null;
			if (!target || this.editorTag) return; // editor: the item goes into Obsidian's menu ("editor-menu")
			const tag = renderedTagAt(target);
			if (!tag) return;
			evt.preventDefault();
			evt.stopPropagation();
			const menu = new Menu();
			this.addMenuItems(menu, tag);
			menu.showAtMouseEvent(evt);
		}, { capture: true });
	}

	// Tag pills in Properties and Bases carry no tag name in their markup (only the text), so CSS can't target
	// one tag. Mark each pill with data-rctc-tag="<tag>"; checked at most once per frame, and only when
	// pills were added.
	watchPills(doc) {
		const selector = TAG_PROPERTY_PILLS.map((p) => `${p} .multi-select-pill`).join(",");
		const mark = () => {
			for (const pill of doc.querySelectorAll(selector)) {
				const tag = normalizeTag(pill.querySelector(".multi-select-pill-content")?.textContent || pill.textContent);
				if (pill.dataset.rctcTag !== tag) pill.dataset.rctcTag = tag;
			}
		};
		let queued = false;
		const observer = new doc.defaultView.MutationObserver((mutations) => {
			if (queued) return;
			const hasPill = mutations.some((m) => [...m.addedNodes].some((n) =>
				n.nodeType === 1 && (n.matches(".multi-select-pill") || n.querySelector(".multi-select-pill"))
				|| n.parentElement?.closest(".multi-select-pill")));
			if (!hasPill) return;
			queued = true;
			doc.defaultView.requestAnimationFrame(() => {
				queued = false;
				mark();
			});
		});
		observer.observe(doc.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
		mark();
	}

	addMenuItems(menu, rawTag) {
		const tag = normalizeTag(rawTag);
		if (!tag) return;
		menu.addItem((item) => item.setTitle(`Color #${tag}…`).setIcon("palette").onClick(() => new TagColorModal(this, tag).open()));
		if (this.settings.tags[tag]) {
			menu.addItem((item) => item.setTitle(`Reset #${tag} color`).setIcon("rotate-ccw").onClick(() => this.setTagColor(tag, null)));
		}
	}

	async setTagColor(tag, color) {
		tag = normalizeTag(tag);
		if (!tag) return;
		if (color) this.settings.tags[tag] = color.toLowerCase();
		else delete this.settings.tags[tag];
		await this.saveSettings();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		const css = this.buildCss();
		for (const el of this.styleEls.values()) el.textContent = css;
	}

	buildCss() {
		const rules = [];
		for (const [tag, color] of Object.entries(this.settings.tags)) {
			const href = cssString("#" + tag);
			const cls = CSS.escape("colored-tag-" + tag);
			const flat = tag.replace(/[^_a-zA-Z0-9\-]/g, "");
			const pills = TAG_PROPERTY_PILLS.map((p) => `body ${p} .multi-select-pill[data-rctc-tag="${cssString(tag)}"]`);
			const selectors = [
				`body a.tag[href="${href}" i]`,
				`body .cm-s-obsidian .cm-line span.cm-hashtag.${cls}`,
				...(flat ? [`body .cm-s-obsidian .cm-line span.cm-hashtag[class~="cm-tag-${flat}" i]`] : []),
				...pills,
			];
			const text = textColorFor(color);
			rules.push(`${selectors.join(",\n")} {\n\tbackground-color: ${color} !important;\n\tbackground-image: none !important;\n\tcolor: ${text} !important;\n}`);
			rules.push(`${pills.map((p) => `${p} .multi-select-pill-remove-button`).join(",\n")} {\n\tcolor: ${text} !important;\n}`);
		}
		return rules.join("\n");
	}
};

// Swatch row: one button per palette color; `current` gets a ring
function renderSwatches(containerEl, palette, current, onPick) {
	const row = containerEl.createDiv({ cls: "rctc-swatches" });
	for (const color of palette) {
		const swatch = row.createEl("button", { cls: "rctc-swatch", attr: { "aria-label": color } });
		swatch.setCssProps({ "--rctc-swatch": color });
		if (current && color.toLowerCase() === current.toLowerCase()) swatch.addClass("is-current");
		swatch.onclick = () => onPick(color);
	}
	return row;
}

class TagColorModal extends Modal {
	constructor(plugin, tag) {
		super(plugin.app);
		this.plugin = plugin;
		this.tag = tag;
	}

	onOpen() {
		const { contentEl } = this;
		const current = this.plugin.settings.tags[this.tag];
		this.titleEl.setText(`Color for #${this.tag}`);
		this.modalEl.addClass("rctc-modal");

		const preview = contentEl.createDiv({ cls: "rctc-preview" }).createEl("a", { cls: "tag", text: "#" + this.tag, attr: { href: "#" + this.tag } });
		preview.onclick = (e) => e.preventDefault();

		contentEl.createDiv({ cls: "rctc-label", text: "Palette" });
		renderSwatches(contentEl, this.plugin.settings.palette, current, (color) => this.pick(color));

		// Fallback when no palette color fits
		const custom = contentEl.createDiv({ cls: "rctc-custom" });
		custom.createSpan({ cls: "rctc-label", text: "Custom" });
		const input = custom.createEl("input", { type: "color", value: current || this.plugin.settings.palette[0] || "#888888" });
		custom.createEl("button", { text: "Use custom color", cls: "mod-cta" }).onclick = () => this.pick(input.value);
		if (current) custom.createEl("button", { text: "Reset" }).onclick = () => this.pick(null);
	}

	async pick(color) {
		await this.plugin.setTagColor(this.tag, color);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TagColorsSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.filter = "";
	}

	display() {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		new Setting(containerEl).setName("Color palette").setHeading()
			.setDesc("The quick colors shown when you right-click a tag. Click a color to change it.");
		// A setting row, so the palette lines up with the rows below it
		const paletteSetting = new Setting(containerEl).setClass("rctc-palette-setting");
		paletteSetting.infoEl.remove();
		const paletteRow = paletteSetting.controlEl.createDiv({ cls: "rctc-palette-edit" });
		settings.palette.forEach((color, i) => {
			const cell = paletteRow.createDiv({ cls: "rctc-palette-cell" });
			const input = cell.createEl("input", { type: "color", value: color, attr: { "aria-label": color } });
			input.onchange = async () => {
				settings.palette[i] = input.value;
				await this.plugin.saveSettings();
			};
			cell.createEl("button", { cls: "rctc-remove", text: "×", attr: { "aria-label": "Remove color" } }).onclick = async () => {
				settings.palette.splice(i, 1);
				await this.plugin.saveSettings();
				this.display();
			};
		});
		paletteRow.createEl("button", { cls: "rctc-add", text: "+", attr: { "aria-label": "Add color" } }).onclick = async () => {
			settings.palette.push("#888888");
			await this.plugin.saveSettings();
			this.display();
		};

		new Setting(containerEl).setName("Tag colors").setHeading()
			.setDesc("Tags without a color here keep their default look, or the color another plugin gives them.");
		let newTag = "";
		const addTag = async () => {
			const tag = normalizeTag(newTag);
			if (!tag) return;
			await this.plugin.setTagColor(tag, settings.tags[tag] || settings.palette[0] || "#888888");
			this.display();
		};
		new Setting(containerEl)
			.setName("Add a tag")
			.addText((text) => {
				text.setPlaceholder("#tag").onChange((v) => (newTag = v));
				text.inputEl.addEventListener("keydown", (e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					addTag();
				});
			})
			.addButton((btn) => btn.setButtonText("Add").setCta().onClick(addTag));

		const tags = Object.keys(settings.tags).sort();
		if (tags.length > 8) {
			new Setting(containerEl).setName("Search").addText((text) => text.setValue(this.filter).setPlaceholder("Filter tags").onChange((v) => {
				this.filter = v.toLowerCase();
				for (const row of containerEl.querySelectorAll(".rctc-tag-row")) row.toggle(!this.filter || row.dataset.tag.includes(this.filter));
			}));
		}

		for (const tag of tags) {
			const setting = new Setting(containerEl).setClass("rctc-tag-row");
			setting.settingEl.dataset.tag = tag;
			setting.settingEl.toggle(!this.filter || tag.includes(this.filter));
			const name = setting.nameEl.createEl("a", { cls: "tag", text: "#" + tag, attr: { href: "#" + tag } });
			name.onclick = (e) => e.preventDefault();
			renderSwatches(setting.controlEl, settings.palette, settings.tags[tag], async (color) => {
				await this.plugin.setTagColor(tag, color);
				this.display();
			});
			setting.addColorPicker((picker) => picker.setValue(settings.tags[tag]).onChange(async (color) => {
				await this.plugin.setTagColor(tag, color);
			}));
			setting.addExtraButton((btn) => btn.setIcon("trash").setTooltip("Remove color").onClick(async () => {
				await this.plugin.setTagColor(tag, null);
				this.display();
			}));
		}
	}
}
