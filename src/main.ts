import { App, Editor, MarkdownRenderer, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
// import { Configuration, OpenAIApi } from "openai"
import { ClientStreamChatCompletionConfig, OpenAIExt } from "openai-ext";

interface RingASecretarySettings {
	token: string;
	defaultSystem: string;
	model: string;
	showConsumedTokens: boolean;
	template: string;
}

const DEFAULT_SETTINGS: RingASecretarySettings = {
	token: "",
	defaultSystem: "",
	model: 'gpt-3.5-turbo-0301',
	showConsumedTokens: false,
	template: "##temperature\n##top_p\n##max_tokens\n##presence_penalty"
}

const roleSystem = "**SYSTEM**";
const roleUser = "**USER**";
const roleAssistant = "**ASSISTANT**";
type DIALOGUE_ROLE = "**SYSTEM**" | "**USER**" | "**ASSISTANT**";
type API_ROLE = "system" | "user" | "assistant";

const MarkToRole = {
	"**SYSTEM**": "system",
	"**USER**": "user",
	"**ASSISTANT**": "assistant",
} as Record<DIALOGUE_ROLE, API_ROLE>;
const RESPONSE_START_MARK = "<span class='ofx-response-start'></span>";
const RESPONSE_END_MARK = "<span class='ofx-thinking'></span>";
const WAIT_MARK_INITIAL = `${RESPONSE_START_MARK}Please, bear with me.`;

function replaceStringBetweenMarks(source: string, newPiece: string, fromMark: string, toMark: string) {
	const start = source.indexOf(fromMark);
	const end = source.indexOf(toMark);
	if (start == -1 || end == -1) return source;
	return source.substring(0, start) + newPiece + source.substring(end + toMark.length);
}

// const WAIT_MARK = "<span class='ofx-response-start'></span><span class='ofx-thinking'></span>Please, bear with me.";
export default class RingASecretaryPlugin extends Plugin {
	settings: RingASecretarySettings;
	configuration: ClientStreamChatCompletionConfig;
	request?: XMLHttpRequest;
	async askToAI(dialogue: string, targetFile: TFile, targetKey: string) {
		if (this.request) {
			new Notice("Some question is already in progress...", 5000);
			return
		}
		const messages = [] as { role: "system" | "user" | "assistant", content: string }[];
		let currentRole = "" as "" | "user" | "system" | "assistant";
		let buffer = "";
		// let temperature: number | undefine = 0; /* 0 -> 1[def] -> 2 */
		// let top_p: number | undefine = undefined; /* 1 def */
		// let max_tokens: number | undefined = undefined; /* inf def */
		// let presence_penalty: number | undefined = undefined; /* -2 -> 2[def] -> 2*/
		const options = {} as {
			temperature?: number,
			top_p?: number,
			max_tokens?: number,
			presence_penalty?: number
		}
		const dialogLines = dialogue.split("\n");
		const params = ["temperature", "top_p", "max_tokens", "presence_penalty"] as ("temperature" | "top_p" | "max_tokens" | "presence_penalty")[];
		for (const line of dialogLines) {
			let lineBuf = line.trim();
			if (lineBuf.startsWith("#")) {
				for (const param of params) {
					const paramHead = `##${param}`;
					if (lineBuf.startsWith(paramHead)) {
						const val = lineBuf.substring(paramHead.length).trim();
						if (val != "") options[param] = Number.parseFloat(val);
					}
					continue;
				}
				continue;
			}
			let newRole = "" as "" | API_ROLE;
			for (const [dialogueRole, APIRole] of Object.entries(MarkToRole)) {
				if (lineBuf.startsWith(dialogueRole)) {
					newRole = APIRole;
					lineBuf = lineBuf.substring(dialogueRole.length + 1);
				}
			}
			if (newRole != "") {
				if (buffer.trim() != "") {
					messages.push({ role: currentRole == "" ? "user" : currentRole, content: buffer.trim() });
					buffer = "";
				}
				currentRole = newRole;
			}
			buffer += lineBuf + "\n";
		}
		if (buffer != "" && !buffer.contains(RESPONSE_START_MARK)) {
			messages.push({ role: currentRole == "" ? "user" : currentRole, content: buffer });
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const _this = this;
		this.request = OpenAIExt.streamClientChatCompletion({
			...options,
			model: this.settings.model,
			messages,
		}, {
			apiKey: this.settings.token,
			allEnvsAllowed: true,
			handler: {
				// Content contains the string draft, which may be partial. When isFinal is true, the completion is done.
				onContent(content, isFinal, xhr) {
					_this.applyResponse(content, isFinal, targetKey, targetFile, dialogue);
				},
				onDone(xhr) {
					//TODO
					_this.request = undefined;
				},
				onError(error, status, xhr) {
					_this.applyResponse(error.message, true, targetKey, targetFile, dialogue);
					console.error(error);
					_this.request = undefined;
				},
			},
		});

	}

	/** Apply the response to the note while streaming, and write response to the file when it has been done. */
	async applyResponse(response: string, isDone: boolean, targetKey: string, targetFile: TFile, basedDialogue: string) {
		if (!isDone) {
			const data = basedDialogue;
			const out = replaceStringBetweenMarks(data, `${RESPONSE_START_MARK}${response}<span id='${targetKey}'></span>`, RESPONSE_START_MARK, RESPONSE_END_MARK);
			const els = document.querySelectorAll(`span#${targetKey}`);
			const el = els.length > 0 ? els[0] as HTMLSpanElement : undefined;
			if (el) {
				const p = el.matchParent("div.obsidian-fx") as HTMLDivElement;
				this.renderMarkdownToEl(p, out, targetFile.path)
			}
			return;
		}
		await this.app.vault.process(targetFile, (data) => {
			const out = replaceStringBetweenMarks(data, `${response}\n`, RESPONSE_START_MARK, RESPONSE_END_MARK);
			return out;
		});
		this.app.vault.trigger("modify", targetFile);

	}
	renderMarkdownToEl(fx: HTMLDivElement, source: string, sourcePath: string) {
		// All pragmatic comments will be hidden, but just simple comments are shown as with strikethrough.
		const renderSource1 = `${source.replace(/^(##.*)$/mg, "<!-- $1 -->").replace(/^#(.*?)\s*$/mg, "~~$1~~")}`;
		// All lines can be deleted or cancelled
		const renderSource2 = renderSource1.split("\n").map((e, i) =>
			e.contains(RESPONSE_START_MARK) ? e.split(roleAssistant).join(`<a href="#" class="fx-toggle-comment" data-line="${i}" data-cancel="1">✋</a>${roleAssistant}`) : e.split(roleAssistant).join(`<a href="#" class="fx-toggle-comment" data-line="${i}">🗑️</a>${roleAssistant}`).split(roleUser).join(`<a href="#" class="fx-toggle-comment"  data-line="${i}">🗑️</a>${roleUser}`))
			.join("\n")
		fx.replaceChildren("");

		const renderSource = `> [!consult]+\n${renderSource2.replace(/^/mg, "> ")}`;
		MarkdownRenderer.renderMarkdown(renderSource, fx, sourcePath, this).then(() => {
			document.querySelectorAll(".fx-toggle-comment").forEach((e) => {
				e.addEventListener("click", (evt) => {
					evt.preventDefault();
					const el = e.matchParent("div.obsidian-fx") as HTMLDivElement;
					if (!el) return;
					const filename = el.getAttribute("data-source-path");
					const line = Number.parseInt(el.getAttribute("data-context-line") as string);
					const commentLine = Number.parseInt(e.getAttribute("data-line") as string);
					if (!filename) return;
					const f = this.app.vault.getAbstractFileByPath(filename);
					if (!(f instanceof TFile)) {
						new Notice("Could not find the file", 3000);
						return;
					}
					const cancel = e.getAttribute("data-cancel");
					if (cancel == "1") {
						if (this.request) {
							this.request.abort();
							this.request = undefined;
							new Notice("Cancelled!", 5000);
						}
					}
					this.app.vault.process(f, (data) => {
						const f = data.split("\n");
						// Toggle commenting out, or remove it if it has been cancelled.
						f[line + commentLine + 1] = cancel == "1" ? "" : f[line + commentLine + 1].startsWith("#") ? f[line + commentLine + 1].substring(1) : `#${f[line + commentLine + 1]}`;
						return f.join("\n");
					});
				})
			});
		})
	}
	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor("aichat", (source, el, ctx) => {
			const uniq = `obsidian-fx-${Date.now()}-${~~(Math.random() * 10000)}`;
			const fx = el.createDiv({ text: "", cls: ["obsidian-fx", uniq] });
			// Store the path and the line to modify later.
			const sourcePath = ctx.sourcePath;
			const secInfo = ctx.getSectionInfo(el);
			fx.setAttribute("data-source-path", sourcePath);
			fx.setAttribute("data-context-line", `${secInfo?.lineStart}`);
			this.renderMarkdownToEl(fx, source, sourcePath);
			const ops = el.createDiv({ text: "", cls: ["obsidian-fx-buttons"] });
			const span = ops.createEl("span", { text: "USER:", cls: "label" });
			const input = ops.createEl("textarea", { cls: "ai-dialogue-input" });
			const submit = ops.createEl("button", { text: "🤵" });
			ops.appendChild(span);
			ops.appendChild(input)
			ops.appendChild(submit);
			el.appendChild(fx);
			el.appendChild(ops)
			const c = new AbortController();
			const submitFunc = async () => {
				if (source.contains(RESPONSE_START_MARK)) {
					new Notice("Some question is already in progress... If not, please modify the code block directly.", 5000);
					return
				}
				const f = this.app.vault.getAbstractFileByPath(sourcePath);
				if (!f) {
					new Notice("Could not find the file", 3000);
					return;
				}
				if (!(f instanceof TFile)) {
					new Notice("Could not find the file", 3000);
					return;
				}
				const dataMain = source;
				const text = input.value;
				if (text.trim() == "") {
					new Notice("Request is empty");
					return;
				}
				//Note: ESCAPE MARKDOWN?
				const newBody = `${dataMain}\n${roleUser}: ${text}\n \n${roleAssistant}: ${WAIT_MARK_INITIAL}<span id='${uniq}'></span>${RESPONSE_END_MARK}`;

				await this.app.vault.process(f, (data) => {
					const dataList = data.split("\n");
					const dataBefore = dataList.slice(0, (secInfo?.lineStart ?? 0) + 1);

					const dataAfter = dataList.slice(secInfo?.lineEnd)

					return dataBefore.join("\n") + `\n${newBody}\n` + dataAfter.join("\n");
				});
				setTimeout(() => {
					this.askToAI(newBody, f, uniq).catch(err => {
						this.applyResponse(`Something has been occurred: ${err?.message}`, true, uniq, f, newBody);
						new Notice(`Something has been occurred: ${err?.message}`);
					});
				}, 20);
				this.app.vault.trigger("modify", f);
			}
			submit.addEventListener("click", submitFunc, { signal: c.signal });
			input.addEventListener("keydown", e => {
				setTimeout(() => {
					if (input.clientHeight < input.scrollHeight) {
						input.style.height = `${input.scrollHeight + 4}px`;
					}
				}, 10);
				if (e.key == "Enter" && (e.shiftKey) && !e.isComposing) {
					e.preventDefault();
					submitFunc();
					input.value = "";
				}
			}, { signal: c.signal, capture: true })
		});


		this.addCommand({
			id: 'new-dialogue',
			name: 'New dialogue',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection(
					`${"````aichat"}
${this.settings.template ? `${this.settings.template}\n` : ""}${this.settings.defaultSystem ? `${roleSystem}: ${this.settings.defaultSystem}` : `#${roleSystem}: `}
${"````"}
`
				)
			}
		});

		this.addSettingTab(new RingASecretarySettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class RingASecretarySettingTab extends PluginSettingTab {
	plugin: RingASecretaryPlugin;

	constructor(app: App, plugin: RingASecretaryPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Settings for Ring a secretary' });

		new Setting(containerEl)
			.setName('Token')
			.setDesc('The token of ChatGPT')
			.addText(text => text
				.setPlaceholder('sk-TrbCVkcuvcshu7b....')
				.setValue(this.plugin.settings.token)
				.onChange(async (value) => {
					this.plugin.settings.token = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model')
			.addText(text => text
				.setPlaceholder('gpt-3.5-turbo-0301')
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Initial prompt')
			.setDesc('Initial prompt; i.e., instructions and prerequisites presented to the AI.')
			.addText(text => text
				.setPlaceholder('Behave as a British English speaker and answer my questions')
				.setValue(this.plugin.settings.defaultSystem)
				.onChange(async (value) => {
					this.plugin.settings.defaultSystem = value;
					await this.plugin.saveSettings();
				}));
		new Setting(containerEl)
			.setName('Conversation customising template')
			.setDesc('')
			.addTextArea(text => text
				.setPlaceholder("")
				.setValue(this.plugin.settings.template)
				.onChange(async (value) => {
					this.plugin.settings.template = value;
					await this.plugin.saveSettings();
				}));
	}
}
