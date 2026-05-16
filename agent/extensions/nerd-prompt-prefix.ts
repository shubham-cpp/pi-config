import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const PROMPT_PREFIX = process.env.PI_PROMPT_PREFIX ?? " ";
const PROMPT_GAP = " ";
const HISTORY_LIMIT = 300;
const SESSION_FILE_LIMIT = 100;
const SEARCH_PANEL_MATCHES = 5;
const SEARCH_PANEL_SELECTED_LINES = 11;
const SEARCH_PANEL_OTHER_LINES = 1;

type ReverseSearchState = {
	query: string;
	draft: string;
	selectedHistoryIndex: number;
	match: string | null;
};

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function isEditorBorder(line: string): boolean {
	const plain = stripAnsi(line);
	return plain.includes("─") && /^[─ ↑↓0-9more]+$/.test(plain);
}

function decodePrintable(data: string): string | undefined {
	const parsed = parseKey(data);
	if (parsed === "space") return " ";
	if (parsed && parsed.length === 1) return parsed;
	return data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
}

function uniquePushHistory(history: string[], text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	const existingIndex = history.indexOf(trimmed);
	if (existingIndex === 0) return;
	if (existingIndex > 0) history.splice(existingIndex, 1);
	history.unshift(trimmed);
	if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

function uniqueAppendHistory(history: string[], text: string): void {
	const trimmed = text.trim();
	if (!trimmed || history.includes(trimmed)) return;
	history.push(trimmed);
	if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

function walkJsonlFiles(dir: string, files: { path: string; mtimeMs: number }[] = []): { path: string; mtimeMs: number }[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return files;
	}

	for (const entry of entries) {
		const path = join(dir, entry);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}

		if (stat.isDirectory()) walkJsonlFiles(path, files);
		else if (entry.endsWith(".jsonl")) files.push({ path, mtimeMs: stat.mtimeMs });
	}

	return files;
}

function messageText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;

	const text = content
		.filter((block): block is { type: string; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string";
		})
		.map((block) => block.text)
		.join("\n")
		.trim();

	return text || null;
}

function loadSessionPromptHistory(): string[] {
	const history: string[] = [];
	const sessionRoot = join(homedir(), ".pi", "agent", "sessions");
	const files = walkJsonlFiles(sessionRoot)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, SESSION_FILE_LIMIT);

	for (const file of files) {
		let lines: string[];
		try {
			lines = readFileSync(file.path, "utf8").split("\n");
		} catch {
			continue;
		}

		for (let index = lines.length - 1; index >= 0; index--) {
			const line = lines[index]?.trim();
			if (!line) continue;

			try {
				const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				if (entry.type !== "message" || entry.message?.role !== "user") continue;
				const text = messageText(entry.message.content);
				if (text) uniqueAppendHistory(history, text);
				if (history.length >= HISTORY_LIMIT) return history;
			} catch {
				continue;
			}
		}
	}

	return history;
}

function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function wrapPlainText(text: string, width: number, maxLines: number): string[] {
	const lines: string[] = [];
	const pushWrappedLine = (rawLine: string) => {
		const words = rawLine.trim().split(/\s+/).filter(Boolean);
		if (words.length === 0) {
			lines.push("");
			return;
		}

		let current = "";
		for (const word of words) {
			const next = current ? `${current} ${word}` : word;
			if (visibleWidth(next) <= width) {
				current = next;
				continue;
			}

			if (current) lines.push(current);
			current = visibleWidth(word) > width ? truncateToWidth(word, width, "") : word;
			if (lines.length >= maxLines) return;
		}
		if (current && lines.length < maxLines) lines.push(current);
	};

	for (const rawLine of text.split("\n")) {
		pushWrappedLine(rawLine);
		if (lines.length >= maxLines) break;
	}

	if (lines.length === maxLines && visibleWidth(lines[maxLines - 1] ?? "") >= Math.max(1, width - 1)) {
		lines[maxLines - 1] = truncateToWidth(lines[maxLines - 1] ?? "", Math.max(1, width - 1), "") + "…";
	}

	return lines.length > 0 ? lines : [""];
}

function centerLineAroundQuery(line: string, query: string, width: number): string {
	const trimmed = line.trim();
	if (!query || visibleWidth(trimmed) <= width) return truncateToWidth(trimmed, width, "…");

	const matchIndex = trimmed.toLowerCase().indexOf(query.toLowerCase());
	if (matchIndex === -1) return truncateToWidth(trimmed, width, "…");

	const queryLength = Math.max(1, query.length);
	const windowChars = Math.max(queryLength, width - 2);
	let start = Math.max(0, matchIndex - Math.floor((windowChars - queryLength) / 2));
	let end = Math.min(trimmed.length, start + windowChars);
	start = Math.max(0, Math.min(start, Math.max(0, end - windowChars)));
	end = Math.min(trimmed.length, Math.max(end, matchIndex + queryLength));

	const hasLeading = start > 0;
	const hasTrailing = end < trimmed.length;
	return `${hasLeading ? "…" : ""}${trimmed.slice(start, end)}${hasTrailing ? "…" : ""}`;
}

function buildMatchPreview(text: string, query: string, width: number, maxLines: number): string[] {
	if (!query) return wrapPlainText(text, width, maxLines);

	const rawLines = text.split(/\r?\n/);
	const matchLineIndex = rawLines.findIndex((line) => line.toLowerCase().includes(query.toLowerCase()));
	if (matchLineIndex === -1) return wrapPlainText(text, width, maxLines);

	if (maxLines <= 1) {
		return [centerLineAroundQuery(rawLines[matchLineIndex] ?? "", query, width)];
	}

	let before = Math.floor((maxLines - 1) / 2);
	let after = maxLines - 1 - before;
	let start = Math.max(0, matchLineIndex - before);
	let end = Math.min(rawLines.length, matchLineIndex + after + 1);
	const hasLeading = start > 0;
	const hasTrailing = end < rawLines.length;
	const reserved = (hasLeading ? 1 : 0) + (hasTrailing ? 1 : 0);
	const contentSlots = Math.max(1, maxLines - reserved);

	before = Math.floor((contentSlots - 1) / 2);
	after = contentSlots - 1 - before;
	start = Math.max(0, matchLineIndex - before);
	end = Math.min(rawLines.length, matchLineIndex + after + 1);

	const preview: string[] = [];
	if (start > 0) preview.push("…");
	for (let index = start; index < end && preview.length < maxLines; index++) {
		const line = rawLines[index] ?? "";
		preview.push(index === matchLineIndex ? centerLineAroundQuery(line, query, width) : truncateToWidth(line.trim(), width, "…"));
	}
	if (end < rawLines.length && preview.length < maxLines) preview.push("…");

	return preview.length > 0 ? preview : [""];
}

function highlightQuery(text: string, query: string, base: (value: string) => string, highlight: (value: string) => string): string {
	if (!query) return base(text);

	const lowerText = text.toLowerCase();
	const lowerQuery = query.toLowerCase();
	const parts: string[] = [];
	let cursor = 0;

	while (cursor < text.length) {
		const index = lowerText.indexOf(lowerQuery, cursor);
		if (index === -1) break;
		if (index > cursor) parts.push(base(text.slice(cursor, index)));
		parts.push(highlight(text.slice(index, index + query.length)));
		cursor = index + query.length;
	}

	if (cursor < text.length) parts.push(base(text.slice(cursor)));
	return parts.join("");
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const sessionPromptHistory = loadSessionPromptHistory();

		class NerdPromptPrefixEditor extends CustomEditor {
			private readonly promptHistory: string[] = [...sessionPromptHistory];
			private reverseSearch: ReverseSearchState | null = null;
			private readonly requestRender: () => void;
			private readonly getRows: () => number;

			constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, theme, keybindings);
				this.requestRender = () => tui.requestRender();
				this.getRows = () => tui.terminal.rows;
			}

			addToHistory(text: string): void {
				uniquePushHistory(this.promptHistory, text);
				super.addToHistory(text);
			}

			handleInput(data: string): void {
				if (matchesKey(data, "ctrl+r")) {
					this.advanceReverseSearch();
					return;
				}

				if (!this.reverseSearch) {
					super.handleInput(data);
					return;
				}

				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+g")) {
					this.cancelReverseSearch();
					return;
				}

				if (matchesKey(data, "enter") || matchesKey(data, "return")) {
					this.acceptReverseSearch();
					return;
				}

				if (matchesKey(data, "up")) {
					this.moveReverseSelection(-1);
					return;
				}

				if (matchesKey(data, "down")) {
					this.moveReverseSelection(1);
					return;
				}

				if (matchesKey(data, "backspace")) {
					this.updateReverseQuery(this.reverseSearch.query.slice(0, -1));
					return;
				}

				const printable = decodePrintable(data);
				if (printable !== undefined) {
					this.updateReverseQuery(this.reverseSearch.query + printable);
					return;
				}
			}

			render(width: number): string[] {
				const lines = super.render(width);
				this.renderPromptPrefix(lines, width);
				if (!this.reverseSearch) return lines;
				return [...this.renderReverseSearchPanel(width), ...lines];
			}

			private advanceReverseSearch(): void {
				if (!this.reverseSearch) {
					this.reverseSearch = {
						query: "",
						draft: this.getText(),
						selectedHistoryIndex: -1,
						match: null,
					};
					this.requestRender();
					return;
				}

				if (this.reverseSearch.query.length === 0) {
					this.requestRender();
					return;
				}

				this.moveReverseSelection(1);
			}

			private updateReverseQuery(query: string): void {
				if (!this.reverseSearch) return;
				this.reverseSearch.query = query;
				this.reverseSearch.selectedHistoryIndex = -1;
				this.selectFirstReverseMatch();
			}

			private reverseMatches(): number[] {
				if (!this.reverseSearch || this.reverseSearch.query.length === 0) return [];
				const query = this.reverseSearch.query.toLowerCase();
				return this.promptHistory
					.map((entry, index) => ({ entry, index }))
					.filter(({ entry }) => entry.toLowerCase().includes(query))
					.map(({ index }) => index);
			}

			private selectFirstReverseMatch(): void {
				if (!this.reverseSearch) return;
				const first = this.reverseMatches()[0];
				this.reverseSearch.selectedHistoryIndex = first ?? -1;
				this.reverseSearch.match = first === undefined ? null : (this.promptHistory[first] ?? null);
				this.requestRender();
			}

			private moveReverseSelection(delta: number): void {
				if (!this.reverseSearch || this.reverseSearch.query.length === 0) {
					this.requestRender();
					return;
				}

				const matches = this.reverseMatches();
				if (matches.length === 0) {
					this.reverseSearch.selectedHistoryIndex = -1;
					this.reverseSearch.match = null;
					this.requestRender();
					return;
				}

				const currentOffset = Math.max(0, matches.indexOf(this.reverseSearch.selectedHistoryIndex));
				const nextOffset = (currentOffset + delta + matches.length) % matches.length;
				const nextIndex = matches[nextOffset] ?? matches[0]!;
				this.reverseSearch.selectedHistoryIndex = nextIndex;
				this.reverseSearch.match = this.promptHistory[nextIndex] ?? null;
				this.requestRender();
			}

			private cancelReverseSearch(): void {
				const draft = this.reverseSearch?.draft;
				this.reverseSearch = null;
				if (draft !== undefined) this.setText(draft);
				this.requestRender();
			}

			private acceptReverseSearch(): void {
				const match = this.reverseSearch?.match;
				this.reverseSearch = null;
				if (match) this.setText(match);
				this.requestRender();
			}

			private renderPromptPrefix(lines: string[], width: number): void {
				const prefix = ctx.ui.theme.fg("accent", PROMPT_PREFIX) + PROMPT_GAP;
				const prefixWidth = visibleWidth(PROMPT_PREFIX + PROMPT_GAP);
				const continuationPrefix = " ".repeat(prefixWidth);
				let insideEditorBody = false;
				let bordersSeen = 0;
				let renderedPrompt = false;

				for (let index = 0; index < lines.length; index++) {
					const line = lines[index] ?? "";
					if (isEditorBorder(line)) {
						bordersSeen++;
						insideEditorBody = bordersSeen === 1;
						continue;
					}

					if (!insideEditorBody) continue;

					const remainingWidth = Math.max(1, width - prefixWidth);
					const linePrefix = renderedPrompt ? continuationPrefix : prefix;
					renderedPrompt = true;
					lines[index] = linePrefix + truncateToWidth(line, remainingWidth, "");
				}
			}

			private renderReverseSearchPanel(width: number): string[] {
				const state = this.reverseSearch;
				if (!state) return [];

				const theme = ctx.ui.theme;
				const matches = this.reverseMatches();
				const selectedOffset = Math.max(0, matches.indexOf(state.selectedHistoryIndex));
				const contentWidth = Math.max(20, width - 4);
				const panelBudget = Math.max(8, Math.min(Math.floor(this.getRows() * 0.55), 24));
				const lines: string[] = [];
				type PanelColor = "accent" | "muted" | "dim" | "warning" | "text";
				const addStyled = (content: string) => {
					const visible = truncateToWidth(content, contentWidth, "…");
					lines.push(theme.fg("borderMuted", "│ ") + padToWidth(visible, contentWidth) + theme.fg("borderMuted", " │"));
				};
				const add = (content: string, color: PanelColor = "text") => {
					addStyled(theme.fg(color, content));
				};

				lines.push(theme.fg("borderMuted", "╭" + "─".repeat(Math.max(0, width - 2)) + "╮"));
				add(`history search: ${state.query || "type to search"}`, state.query ? "accent" : "dim");

				if (state.query.length === 0) {
					add("", "dim");
					add("Start typing to search previous prompts.", "muted");
				} else if (matches.length === 0) {
					add("", "dim");
					add("No matching prompts.", "warning");
				} else {
					const half = Math.floor(SEARCH_PANEL_MATCHES / 2);
					const start = Math.max(0, Math.min(selectedOffset - half, Math.max(0, matches.length - SEARCH_PANEL_MATCHES)));
					const visibleMatches = matches.slice(start, start + SEARCH_PANEL_MATCHES);

					for (const historyIndex of visibleMatches) {
						if (lines.length >= panelBudget - 2) break;
						const selected = historyIndex === state.selectedHistoryIndex;
						const offset = matches.indexOf(historyIndex) + 1;
						const marker = selected ? "›" : " ";
						const text = this.promptHistory[historyIndex] ?? "";
						const maxPreviewLines = selected ? SEARCH_PANEL_SELECTED_LINES : SEARCH_PANEL_OTHER_LINES;
						const previewWidth = Math.max(8, contentWidth - 8);
						const previewLines = buildMatchPreview(text, state.query, previewWidth, maxPreviewLines);
						const count = `${offset}/${matches.length}`;

						for (let lineIndex = 0; lineIndex < previewLines.length; lineIndex++) {
							if (lines.length >= panelBudget - 2) break;
							const prefix = lineIndex === 0 ? `${marker} ${count.padStart(5)} ` : "        ";
							const baseColor: PanelColor = selected ? "text" : "muted";
							const prefixText = theme.fg(selected ? "accent" : "dim", prefix);
							const preview = highlightQuery(
								previewLines[lineIndex] ?? "",
								state.query,
								(value) => theme.fg(baseColor, value),
								(value) => theme.bg("selectedBg", theme.fg("accent", value)),
							);
							addStyled(prefixText + preview);
						}
					}
				}

				while (lines.length < panelBudget - 2) add("", "dim");
				add("↑↓ navigate · Ctrl-r next · Enter accept · Esc cancel", "dim");
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(Math.max(0, width - 2)) + "╯"));
				return lines;
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => new NerdPromptPrefixEditor(tui, theme, keybindings));
	});
}
