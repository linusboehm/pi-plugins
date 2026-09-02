/**
 * Derived from Mitsupi's answer extension:
 * https://github.com/mitsuhiko/agent-stuff
 * Licensed under Apache-2.0. Modified to use current Pi package names,
 * authenticated model-registry requests, and explicit extraction errors.
 */

/**
 * Q&A extraction hook - extracts questions from assistant responses
 *
 * Custom interactive TUI for answering questions.
 *
 * Demonstrates the "prompt generator" pattern with custom TUI:
 * 1. /answer command gets the last assistant message
 * 2. Shows a spinner while extracting questions as structured JSON
 * 3. Presents an interactive TUI to navigate and answer questions
 * 4. Submits the compiled answers when done
 */

import { type Model, type Api, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Structured output format for question extraction
interface ExtractedQuestion {
	question: string;
	context?: string;
	recommendation?: string;
	options?: string[];
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type ExtractionOutcome =
	| { status: "success"; result: ExtractionResult }
	| { status: "cancelled" }
	| { status: "error"; message: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering.

Output a JSON object with this structure:
{
  "questions": [
    {
      "question": "The question text",
      "context": "Optional context that helps answer the question",
      "recommendation": "Optional recommendation explicitly given in the source text",
      "options": ["a) First option", "b) Second option"]
    }
  ]
}

Rules:
- Extract all questions that require user input
- Keep questions in the order they appeared
- Preserve each question's original wording, Markdown, line breaks, and inline formatting exactly
- Do not summarize, rephrase, or strip formatting from a question
- Include context only when it provides essential information for answering, preserving its original formatting
- Include recommendation only when the source text explicitly recommends an answer or approach; never invent one
- When a question has multiple-choice options, include every option and preserve its original marker and wording exactly
- Recognize lettered and numbered options such as "a)", "B.", "1.", and "2)"
- Omit options for open-ended questions
- If no questions are found, return {"questions": []}

Example output:
{
  "questions": [
    {
      "question": "What is your preferred database?",
      "context": "We can only configure MySQL and PostgreSQL because of what is implemented.",
      "recommendation": "PostgreSQL is recommended because the deployment already supports it.",
      "options": ["a) MySQL", "b) PostgreSQL"]
    },
    {
      "question": "Should we use TypeScript or JavaScript?"
    }
  ]
}`;

const CODEX_MODEL_ID = "gpt-5.1-codex-mini";
const HAIKU_MODEL_ID = "claude-haiku-4-5";

/**
 * Prefer Codex mini for extraction when available, otherwise fallback to haiku or the current model.
 */
async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const codexModel = modelRegistry.find("openai-codex", CODEX_MODEL_ID);
	if (codexModel && modelRegistry.hasConfiguredAuth(codexModel)) {
		return codexModel;
	}

	const haikuModel = modelRegistry.find("anthropic", HAIKU_MODEL_ID);
	if (!haikuModel) {
		return currentModel;
	}

	if (!modelRegistry.hasConfiguredAuth(haikuModel)) {
		return currentModel;
	}

	return haikuModel;
}

/**
 * Parse the JSON response from the LLM
 */
function parseExtractionResult(text: string): ExtractionResult | null {
	try {
		// Try to find JSON in the response (it might be wrapped in markdown code blocks)
		let jsonStr = text;

		// Remove markdown code block if present
		const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		}

		const parsed = JSON.parse(jsonStr) as { questions?: unknown };
		if (parsed && Array.isArray(parsed.questions)) {
			const questions: ExtractedQuestion[] = [];
			for (const value of parsed.questions) {
				if (!value || typeof value !== "object") return null;
				const item = value as Record<string, unknown>;
				if (typeof item.question !== "string" || !item.question.trim()) return null;
				if (item.context !== undefined && typeof item.context !== "string") return null;
				if (item.recommendation !== undefined && typeof item.recommendation !== "string") return null;
				if (
					item.options !== undefined &&
					(!Array.isArray(item.options) || item.options.some((option) => typeof option !== "string"))
				) {
					return null;
				}

				questions.push({
					question: item.question.trim(),
					...(typeof item.context === "string" && item.context.trim()
						? { context: item.context.trim() }
						: {}),
					...(typeof item.recommendation === "string" && item.recommendation.trim()
						? { recommendation: item.recommendation.trim() }
						: {}),
					...(Array.isArray(item.options)
						? { options: item.options.map((option) => option.trim()).filter(Boolean) }
						: {}),
				});
			}
			return { questions };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Interactive Q&A component for answering extracted questions
 */
class QnAComponent implements Component {
	private questions: ExtractedQuestion[];
	private answers: string[];
	private customDrafts: string[];
	private selectedChoices: number[];
	private focusModes: Array<"choices" | "editor">;
	private currentIndex: number = 0;
	private editor: Editor;
	private tui: TUI;
	private theme: Theme;
	private onDone: (result: string | null) => void;
	private showingConfirmation: boolean = false;

	// Cache
	private cachedWidth?: number;
	private cachedLines?: string[];

	private dim = (s: string) => this.theme.fg("dim", s);
	private bold = (s: string) => this.theme.bold(s);
	private accent = (s: string) => this.theme.fg("accent", s);
	private success = (s: string) => this.theme.fg("success", s);
	private warning = (s: string) => this.theme.fg("warning", s);
	private muted = (s: string) => this.theme.fg("muted", s);

	constructor(
		questions: ExtractedQuestion[],
		tui: TUI,
		theme: Theme,
		onDone: (result: string | null) => void,
	) {
		this.questions = questions;
		this.answers = questions.map(() => "");
		this.customDrafts = questions.map(() => "");
		this.selectedChoices = questions.map(() => 0);
		this.focusModes = questions.map((question) =>
			this.choiceLabels(question).length > 1 ? "choices" : "editor",
		);
		this.tui = tui;
		this.theme = theme;
		this.onDone = onDone;

		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedBg: (s: string) => this.theme.bg("selectedBg", this.theme.fg("text", s)),
				matchHighlight: this.accent,
				itemSecondary: this.muted,
			},
		};

		this.editor = new Editor(tui, editorTheme);
		// Disable the editor's built-in submit (which clears the editor)
		// We'll handle Enter ourselves to preserve the text
		this.editor.disableSubmit = true;
		this.editor.onChange = () => {
			this.invalidate();
			this.tui.requestRender();
		};
	}

	private choiceLabels(question: ExtractedQuestion): string[] {
		const choices: string[] = [];
		if (question.recommendation) choices.push("Agree with recommendation");
		choices.push(...(question.options ?? []));
		choices.push("Write a custom reply");
		return choices;
	}

	private customChoiceIndex(question: ExtractedQuestion): number {
		return this.choiceLabels(question).length - 1;
	}

	private selectedChoiceAnswer(question: ExtractedQuestion, index: number): string | undefined {
		if (question.recommendation) {
			if (index === 0) return `Agree with recommendation: ${question.recommendation}`;
			return question.options?.[index - 1];
		}
		return question.options?.[index];
	}

	private saveCurrentAnswer(): void {
		if (this.focusModes[this.currentIndex] === "editor") {
			// Large pastes are collapsed to markers for display. Capture the expanded
			// value before setText() clears the editor's paste metadata on navigation.
			this.customDrafts[this.currentIndex] = this.editor.getExpandedText();
			this.answers[this.currentIndex] = this.customDrafts[this.currentIndex];
		}
	}

	private chooseCurrentOption(): boolean {
		const question = this.questions[this.currentIndex];
		const selected = this.selectedChoices[this.currentIndex];
		if (selected === this.customChoiceIndex(question)) {
			this.focusModes[this.currentIndex] = "editor";
			this.editor.setText(this.customDrafts[this.currentIndex] || "");
			return false;
		}

		this.answers[this.currentIndex] = this.selectedChoiceAnswer(question, selected) ?? "";
		return true;
	}

	private advance(): void {
		this.saveCurrentAnswer();
		if (this.currentIndex < this.questions.length - 1) {
			this.navigateTo(this.currentIndex + 1);
		} else {
			this.showingConfirmation = true;
		}
	}

	private navigateTo(index: number): void {
		if (index < 0 || index >= this.questions.length) return;
		this.saveCurrentAnswer();
		this.currentIndex = index;
		this.editor.setText(this.customDrafts[index] || "");
		this.invalidate();
	}

	private submit(): void {
		this.saveCurrentAnswer();

		const parts = this.questions.map((question, index) => {
			const answer = this.answers[index]?.trim();
			if (!answer) return `Q${index + 1}: No answer.`;

			if (this.focusModes[index] === "editor") {
				return `Q${index + 1}: Custom response: ${answer}`;
			}

			const selected = this.selectedChoices[index];
			if (question.recommendation && selected === 0) {
				return `Q${index + 1}: Agree with recommendation.`;
			}

			const optionIndex = selected - (question.recommendation ? 1 : 0) + 1;
			return `Q${index + 1}: Selected option ${optionIndex}.`;
		});

		this.onDone(parts.join("\n"));
	}

	private cancel(): void {
		this.onDone(null);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.showingConfirmation) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") {
				this.submit();
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.showingConfirmation = false;
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		const question = this.questions[this.currentIndex];
		const choices = this.choiceLabels(question);
		const focus = this.focusModes[this.currentIndex];

		if (matchesKey(data, Key.ctrl("c"))) {
			this.cancel();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			if (focus === "editor" && choices.length > 1) {
				this.saveCurrentAnswer();
				this.focusModes[this.currentIndex] = "choices";
				this.selectedChoices[this.currentIndex] = this.customChoiceIndex(question);
				this.invalidate();
				this.tui.requestRender();
			} else {
				this.cancel();
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			if (focus === "choices") this.chooseCurrentOption();
			this.advance();
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			if (this.currentIndex > 0) this.navigateTo(this.currentIndex - 1);
			this.tui.requestRender();
			return;
		}

		if (focus === "choices") {
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				const direction = matchesKey(data, Key.up) ? -1 : 1;
				const current = this.selectedChoices[this.currentIndex];
				this.selectedChoices[this.currentIndex] = (current + direction + choices.length) % choices.length;
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (this.chooseCurrentOption()) this.advance();
				this.invalidate();
				this.tui.requestRender();
				return;
			}

			// Printable input immediately selects the custom reply and starts editing.
			if (!data.startsWith("\x1b") && data >= " ") {
				this.selectedChoices[this.currentIndex] = this.customChoiceIndex(question);
				this.focusModes[this.currentIndex] = "editor";
				this.editor.setText(this.customDrafts[this.currentIndex] || "");
				this.editor.handleInput(data);
				this.invalidate();
				this.tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			this.advance();
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 120); // Allow wider box
		const contentWidth = boxWidth - 4; // 2 chars padding on each side

		// Helper to create horizontal lines (dim the whole thing at once)
		const horizontalLine = (count: number) => "─".repeat(count);

		// Helper to create a box line
		const boxLine = (content: string, leftPad: number = 2): string => {
			const paddedContent = " ".repeat(leftPad) + content;
			const contentLen = visibleWidth(paddedContent);
			const rightPad = Math.max(0, boxWidth - contentLen - 2);
			return this.dim("│") + paddedContent + " ".repeat(rightPad) + this.dim("│");
		};

		const emptyBoxLine = (): string => {
			return this.dim("│") + " ".repeat(boxWidth - 2) + this.dim("│");
		};

		const padToWidth = (line: string): string => {
			const len = visibleWidth(line);
			return line + " ".repeat(Math.max(0, width - len));
		};

		// Title
		lines.push(padToWidth(this.dim("╭" + horizontalLine(boxWidth - 2) + "╮")));
		const title = `${this.bold(this.accent("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`;
		lines.push(padToWidth(boxLine(title)));
		lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));

		// Progress indicator
		const progressParts: string[] = [];
		for (let i = 0; i < this.questions.length; i++) {
			const answered = (this.answers[i]?.trim() || "").length > 0;
			const current = i === this.currentIndex;
			if (current) {
				progressParts.push(this.accent("●"));
			} else if (answered) {
				progressParts.push(this.success("●"));
			} else {
				progressParts.push(this.dim("○"));
			}
		}
		lines.push(padToWidth(boxLine(progressParts.join(" "))));
		lines.push(padToWidth(emptyBoxLine()));

		// Render the extractor's verbatim question as Markdown.
		const q = this.questions[this.currentIndex];
		lines.push(padToWidth(boxLine(this.bold("Q:"))));
		const renderedQuestion = new Markdown(q.question, 0, 0, getMarkdownTheme()).render(contentWidth - 2);
		for (const line of renderedQuestion) lines.push(padToWidth(boxLine(line, 4)));

		// Context if present
		if (q.context) {
			lines.push(padToWidth(emptyBoxLine()));
			const contextText = this.muted(`> ${q.context}`);
			const wrappedContext = wrapTextWithAnsi(contextText, contentWidth - 2);
			for (const line of wrappedContext) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		// Recommendation if present
		if (q.recommendation) {
			lines.push(padToWidth(emptyBoxLine()));
			const recommendationText = `${this.warning("Recommended:")} ${q.recommendation}`;
			const wrappedRecommendation = wrapTextWithAnsi(recommendationText, contentWidth);
			for (const line of wrappedRecommendation) {
				lines.push(padToWidth(boxLine(line)));
			}
		}

		const choices = this.choiceLabels(q);
		if (choices.length > 1) {
			lines.push(padToWidth(emptyBoxLine()));
			lines.push(padToWidth(boxLine(this.bold("Choose an answer:"))));
			for (let index = 0; index < choices.length; index++) {
				const selected = this.focusModes[this.currentIndex] === "choices" && this.selectedChoices[this.currentIndex] === index;
				const marker = selected ? this.accent("❯") : " ";
				const label = index === 0 && q.recommendation ? this.warning(choices[index]) : choices[index];
				const wrappedChoice = wrapTextWithAnsi(`${marker} ${label}`, contentWidth - 2);
				for (const line of wrappedChoice) lines.push(padToWidth(boxLine(line, 4)));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Render the editor component (multi-line input) with padding
		// Skip the first and last lines (editor's own border lines)
		const editing = this.focusModes[this.currentIndex] === "editor";
		const answerPrefix = editing ? this.bold(this.accent("A: ")) : this.bold("A: ");
		const editorWidth = contentWidth - 4 - 3; // Extra padding + space for "A: "
		const editorLines = this.editor.render(editorWidth);
		for (let i = 1; i < editorLines.length - 1; i++) {
			if (i === 1) {
				// First content line gets the "A: " prefix
				lines.push(padToWidth(boxLine(answerPrefix + editorLines[i])));
			} else {
				// Subsequent lines get padding to align with the first line
				lines.push(padToWidth(boxLine("   " + editorLines[i])));
			}
		}

		lines.push(padToWidth(emptyBoxLine()));

		// Confirmation dialog or footer with controls
		if (this.showingConfirmation) {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const confirmMsg = `${this.warning("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`;
			lines.push(padToWidth(boxLine(truncateToWidth(confirmMsg, contentWidth))));
		} else {
			lines.push(padToWidth(this.dim("├" + horizontalLine(boxWidth - 2) + "┤")));
			const controls = this.focusModes[this.currentIndex] === "choices"
				? `${this.dim("↑/↓")} choose · ${this.dim("Enter")} select · ${this.dim("type")} custom reply · ${this.dim("Tab")} next · ${this.dim("Esc")} cancel`
				: `${this.dim("Enter/Tab")} next · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} choices · ${this.dim("Ctrl+C")} cancel`;
			lines.push(padToWidth(boxLine(truncateToWidth(controls, contentWidth))));
		}
		lines.push(padToWidth(this.dim("╰" + horizontalLine(boxWidth - 2) + "╯")));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("answer requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Select the best model for extraction (prefer Codex mini, then haiku)
			const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);

			// Run extraction with loader UI
			const extractionOutcome = await ctx.ui.custom<ExtractionOutcome>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModel.id}...`);
				loader.onAbort = () => done({ status: "cancelled" });

				const doExtract = async () => {
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text: lastAssistantText! }],
						timestamp: Date.now(),
					};

					const response = await ctx.modelRegistry.complete(
						extractionModel,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ signal: loader.signal },
					);

					if (response.stopReason === "aborted") {
						return { status: "cancelled" } as const;
					}
					if (response.stopReason === "error") {
						throw new Error(response.errorMessage || "Question extraction request failed");
					}

					const responseText = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");

					const result = parseExtractionResult(responseText);
					if (!result) {
						throw new Error("Question extractor returned invalid JSON");
					}
					return { status: "success", result } as const;
				};

				doExtract()
					.then(done)
					.catch((error: unknown) => done({ status: "error", message: errorMessage(error) }));

				return loader;
			});

			if (extractionOutcome.status === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extractionOutcome.status === "error") {
				ctx.ui.notify(`Unable to extract questions: ${extractionOutcome.message}`, "error");
				return;
			}

			const extractionResult = extractionOutcome.result;

			if (extractionResult.questions.length === 0) {
				ctx.ui.notify("No questions found in the last message", "info");
				return;
			}

			// Show the Q&A component
			const answersResult = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				return new QnAComponent(extractionResult.questions, tui, theme, done);
			});

			if (answersResult === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Send the answers directly as a message and trigger a turn
			pi.sendMessage(
				{
					customType: "answers",
					content: "I answered your questions in the following way:\n\n" + answersResult,
					display: true,
				},
				{ triggerTurn: true },
			);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
