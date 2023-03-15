import { App, Editor, MarkdownRenderer, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { Configuration, OpenAIApi } from "openai"
import axios from "axios";

interface RingASecretarySettings {
	token: string;
	defaultSystem: string;
}

const DEFAULT_SETTINGS: RingASecretarySettings = {
	token: "",
	defaultSystem: "",
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
const WAIT_MARK = " WAITING FOR RESPONSE...";

export default class RingASecretaryPlugin extends Plugin {
	settings: RingASecretarySettings;
	configuration: Configuration;
	processingFile?: TFile;
	async askToAI(dialogue: string) {
		const messages = [] as { role: "system" | "user" | "assistant", content: string }[];

		let currentRole = "user" as "user" | "system" | "assistant";
		let buffer = "";
		const dialogLines = dialogue.split("\n");
		for (const line of dialogLines) {
			let lineBuf = line.trim();
			if (lineBuf.startsWith("#")) continue;
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

		const openai = new OpenAIApi(this.configuration);
		const response = await openai.createChatCompletion({


			model: "gpt-3.5-turbo-0301",
			messages
			// temperature: 0,
			// max_tokens: 7,
		});
		const responseContent = response.data.choices[0].message?.content;
		// const responseRole = response.data.choices[0].message?.role;
		this.writeResponseToFile(responseContent ?? "");

	}
	async writeResponseToFile(response: string) {
		if (!this.processingFile) return;
		const file = this.processingFile;
		await app.vault.process(file, (data) => {
			return data.replace(WAIT_MARK, response);
		});
		app.vault.trigger("modify", file);
		this.processingFile = undefined;
	}
	async onload() {
		await this.loadSettings();
		axios.defaults.adapter = "http";
		this.configuration = new Configuration({ apiKey: this.settings.token });

		this.registerMarkdownCodeBlockProcessor("aichat", (source, el, ctx) => {

			const sourcePath = ctx.sourcePath;
			const fx = el.createDiv({ text: "", cls: ["obsidian-fx"] });
			MarkdownRenderer.renderMarkdown(source, fx, sourcePath, this)
			const ops = el.createDiv({ text: "", cls: ["obsidian-fx-buttons"] });
			const span = ops.createSpan({ text: "USER:" });
			const input = ops.createEl("textarea");
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
				if (source.contains(WAIT_MARK)) {
					new Notice("Some question is already in progress...", 5000)//TODO:MESSAGE
					return
				}
				const f = app.vault.getAbstractFileByPath(sourcePath);
				if (!f) {
					new Notice("Could not edit the file", 3000);
					return;
				}
				if (!(f instanceof TFile)) {
					new Notice("Could not edit the file", 3000);
					return;
				}
				const dataMain = source;
				const text = input.value;
				//TODO:ESCAPE MARKDOWN?
				const newBody = `${dataMain}\n${roleUser}:${text} \n${roleAssistant}: ${WAIT_MARK}`;

				await app.vault.process(f, (data) => {
					const dataList = data.split("\n");
					const dataBefore = dataList.slice(0, (secInfo?.lineStart ?? 0) + 1);

					const dataAfter = dataList.slice(secInfo?.lineEnd)

					return dataBefore.join("\n") + `\n${newBody}\n` + dataAfter.join("\n");
				});
				this.processingFile = f;
				setTimeout(() => {
					this.askToAI(newBody).catch(err => {
						this.writeResponseToFile("Something has been occurred (PLUGIN)")
					});
				}, 20);
				app.vault.trigger("modify", f);
			}
			submit.addEventListener("click", submitFunc, { signal: c.signal });
			input.addEventListener("keydown", e => {
				console.dir(e);
				if (e.key == "Enter" && (e.shiftKey) && !e.isComposing) {
					e.preventDefault();
					submitFunc();
					input.value = "";
				}
			}, { signal: c.signal, capture: true })
		});


		this.addCommand({
			id: 'obs-chat-new-dialogue',
			name: 'New dialogue',
			editorCallback: async (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection(
					`${"```aichat"}
${this.settings.defaultSystem ? `${roleSystem}:${this.settings.defaultSystem}` : `#${roleSystem}:`}
${"```"}
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
			.setName('Initial prompt')
			.setDesc('Initial prompt; i.e., instructions and prerequisites presented to the AI.')
			.addText(text => text
				.setPlaceholder('Behave as a British English speaker and answer my questions')
				.setValue(this.plugin.settings.defaultSystem)
				.onChange(async (value) => {
					this.plugin.settings.defaultSystem = value;
					await this.plugin.saveSettings();
				}));
	}
}