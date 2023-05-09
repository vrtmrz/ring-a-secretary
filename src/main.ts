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
const WAIT_MARK_INITIAL = `${RESPONSE_START_MARK}Please, bear with me.${RESPONSE_END_MARK}`;
// const WAIT_MARK = "<span class='ofx-response-start'></span><span class='ofx-thinking'></span>Please, bear with me.";
export default class RingASecretaryPlugin extends Plugin {
	settings: RingASecretarySettings;
	configuration: ClientStreamChatCompletionConfig;
	processingFile?: TFile;
	async askToAI(dialogue: string) {
		const messages = [] as { role: "system" | "user" | "assistant", content: string }[];

		let currentRole = "user" as "user" | "system" | "assistant";
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
			console.dir(options);
			let newRole = "" as "" | API_ROLE;
			for (const [dialogueRole, APIRole] of Object.entries(MarkToRole)) {
				if (lineBuf.startsWith(dialogueRole)) {
					newRole = APIRole;
					lineBuf = lineBuf.substring(dialogueRole.length + 1);
				}
			}
			if (newRole != "" && buffer.trim() != "") {
				messages.push({ role: currentRole, content: buffer.trim() });
				currentRole = newRole;
				buffer = "";
			}
			buffer += lineBuf + "\n";
		}
		if (buffer != "") {
			messages.push({ role: currentRole, content: buffer });
		}
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const _this = this;

		const request = OpenAIExt.streamClientChatCompletion({
			...options,
			model: this.settings.model,
			messages,
		}, {
			apiKey: this.settings.token,
			allEnvsAllowed: true,
			handler: {
				// Content contains the string draft, which may be partial. When isFinal is true, the completion is done.
				onContent(content, isFinal, xhr) {
					_this.writeResponseToFile(content, isFinal);
				},
				onDone(xhr) {
					//TODO
				},
				onError(error, status, xhr) {
					_this.writeResponseToFile(error.message, true);
					console.error(error);
				},
			},
		});

	}

	/** Write response to processing file by replacing placeholder. */
	async writeResponseToFile(response: string, isDone: boolean) {
		if (!this.processingFile) return;
		const file = this.processingFile;
		await this.app.vault.process(file, (data) => {
			const [head, ...midArr] = data.split(RESPONSE_START_MARK);
			const mid = midArr.join(RESPONSE_START_MARK);
			const [oldMessage, ...tailArr] = mid.split(RESPONSE_END_MARK);
			const tail = tailArr.join(RESPONSE_END_MARK);
			if (isDone) {
				this.processingFile = undefined;
				return `${head}${response}\n${tail}`;
			} else {
				return `${head}${RESPONSE_START_MARK}${response}${RESPONSE_END_MARK}${tail}`;
			}
		});
		this.app.vault.trigger("modify", file);

	}

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor("aichat", (source, el, ctx) => {

			const sourcePath = ctx.sourcePath;
			const fx = el.createDiv({ text: "", cls: ["obsidian-fx"] });
			const renderSource = `> [!consult]+\n${source.replace(/^(#.*)$/mg, "<!-- $1 -->").replace(/^/mg, "> ")}`;
			MarkdownRenderer.renderMarkdown(renderSource, fx, sourcePath, this)
			const ops = el.createDiv({ text: "", cls: ["obsidian-fx-buttons"] });
			const span = ops.createEl("span", { text: "USER:", cls: "label" });
			const input = ops.createEl("textarea", { cls: "ai-dialogue-input" });
			const submit = ops.createEl("button", { text: "🤵" });
			const secInfo = ctx.getSectionInfo(el);
			ops.appendChild(span);
			ops.appendChild(input)
			ops.appendChild(submit);
			fx.appendChild(ops)
			el.replaceWith(fx);
			// ctx.
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
				const newBody = `${dataMain}\n${roleUser}: ${text}\n \n${roleAssistant}: ${WAIT_MARK_INITIAL}`;

				await this.app.vault.process(f, (data) => {
					const dataList = data.split("\n");
					const dataBefore = dataList.slice(0, (secInfo?.lineStart ?? 0) + 1);

					const dataAfter = dataList.slice(secInfo?.lineEnd)

					return dataBefore.join("\n") + `\n${newBody}\n` + dataAfter.join("\n");
				});
				this.processingFile = f;
				setTimeout(() => {
					this.askToAI(newBody).catch(err => {
						this.writeResponseToFile(`Something has been occurred: ${err?.message}`, true);
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
