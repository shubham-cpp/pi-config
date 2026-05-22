import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Fish-style single-line footer for pi.
 *
 * Layout:
 *   <fish cwd> [git-branch]  <context mini bar>          <mode> (<reasoning>)
 *
 * Fish prompt_pwd behavior: replace $HOME with ~ and shorten every directory
 * component except the last to one character. Dot-directories keep the dot plus
 * one following character, like .config -> .c.
 */
export default function fishFooter(pi: ExtensionAPI) {
	let activeTui: { requestRender(): void } | undefined;
	let isWorking = false;
	let spinnerIndex = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let usageTimer: ReturnType<typeof setInterval> | undefined;
	let codexUsageText = "";
	let codexUsageFetchedAt = 0;
	let codexUsageRefresh: Promise<void> | undefined;
	const spinnerFrames = ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥"];
	const modelUsageSeparator = "  ";

	function stopSpinner() {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = undefined;
		}
	}

	function fishPath(cwd: string): string {
		const home = process.env.HOME;
		let path = home && cwd === home ? "~" : home && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;

		const isAbsolute = path.startsWith("/");
		const parts = path.split("/").filter(Boolean);
		if (parts.length <= 1) return path;

		const first = isAbsolute ? "/" : "";
		const shortened = parts.map((part, index) => {
			const isLast = index === parts.length - 1;
			if (isLast || part === "~") return part;
			if (part.startsWith(".") && part.length > 1) return part.slice(0, 2);
			return part.slice(0, 1);
		});

		return first + shortened.join("/");
	}

	function formatPercent(value: number | null | undefined): string {
		return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "?%";
	}

	function formatTokens(value: number | null | undefined): string {
		if (typeof value !== "number" || !Number.isFinite(value)) return "?";
		if (value < 1000) return `${Math.round(value)}`;
		return `${(value / 1000).toFixed(1)}K`;
	}

	function readJson(path: string): any | undefined {
		try {
			if (!existsSync(path)) return undefined;
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	}

	function loadCodexCredentials(): { accessToken?: string; accountId?: string } {
		const envAccess =
			process.env.OPENAI_CODEX_OAUTH_TOKEN ||
			process.env.OPENAI_CODEX_ACCESS_TOKEN ||
			process.env.CODEX_OAUTH_TOKEN ||
			process.env.CODEX_ACCESS_TOKEN;
		const envAccount = process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.CHATGPT_ACCOUNT_ID;
		if (envAccess) return { accessToken: envAccess, accountId: envAccount };

		const piAuth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
		const piCodex = piAuth?.["openai-codex"];
		const piAccess = piCodex?.access || piCodex?.accessToken || piCodex?.tokens?.access_token;
		const piAccount = piCodex?.accountId || piCodex?.account_id || piCodex?.tokens?.account_id;
		if (piAccess) return { accessToken: piAccess, accountId: piAccount || envAccount };

		const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
		const codexAuth = readJson(join(codexHome, "auth.json"));
		const codexAccess = codexAuth?.OPENAI_API_KEY || codexAuth?.tokens?.access_token;
		const codexAccount = codexAuth?.tokens?.account_id;
		return { accessToken: codexAccess, accountId: codexAccount || envAccount };
	}

	function windowLabel(window: any, fallbackSeconds: number): string {
		const seconds = typeof window?.limit_window_seconds === "number" ? window.limit_window_seconds : fallbackSeconds;
		const hours = Math.round(seconds / 3600);
		if (hours >= 144) return "W";
		if (hours >= 1) return `${hours}H`;
		return "?";
	}

	function formatUsageWindow(window: any, fallbackSeconds: number): string | undefined {
		const used = window?.used_percent;
		if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
		const remaining = Math.max(0, Math.min(100, 100 - used));
		return `[${windowLabel(window, fallbackSeconds)}: ${Math.round(remaining)}%]`;
	}

	function formatCodexUsage(data: any): string {
		const rateLimit = data?.rate_limit;
		const windows = [
			formatUsageWindow(rateLimit?.primary_window, 18_000),
			formatUsageWindow(rateLimit?.secondary_window, 604_800),
		].filter(Boolean);
		return windows.join(" ");
	}

	async function refreshCodexUsage(force = false): Promise<void> {
		const now = Date.now();
		if (!force && now - codexUsageFetchedAt < 180_000) return;
		if (codexUsageRefresh) return codexUsageRefresh;

		codexUsageRefresh = (async () => {
			const { accessToken, accountId } = loadCodexCredentials();
			if (!accessToken) {
				codexUsageFetchedAt = Date.now();
				codexUsageRefresh = undefined;
				return;
			}

			try {
				const headers: Record<string, string> = {
					Accept: "application/json",
					Authorization: `Bearer ${accessToken}`,
				};
				if (accountId) headers["ChatGPT-Account-Id"] = accountId;

				const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
				if (!response.ok) return;

				const nextText = formatCodexUsage(await response.json());
				codexUsageFetchedAt = Date.now();
				if (nextText) codexUsageText = nextText;
				activeTui?.requestRender();
			} catch {
				// Keep the previous successful value; the footer should stay quiet on transient failures.
			} finally {
				codexUsageRefresh = undefined;
			}
		})();

		return codexUsageRefresh;
	}

	function contextBar(ctx: any, theme: any): string {
		const usage = ctx.getContextUsage?.();
		const percent = typeof usage?.percent === "number" ? Math.max(0, Math.min(100, usage.percent)) : null;
		const tokens = typeof usage?.tokens === "number" ? usage.tokens : null;
		const barWidth = 10;
		const filled = percent === null ? 0 : Math.round((percent / 100) * barWidth);

		const color = percent === null ? "muted" : percent >= 85 ? "error" : percent >= 68 ? "warning" : percent >= 45 ? "accent" : "muted";
		const label = `${formatPercent(percent)} (${formatTokens(tokens)})`;
		const full = "▰".repeat(filled);
		const empty = "▱".repeat(barWidth - filled);

		return `${theme.fg("dim", "ctx ")}${theme.fg(color, full)}${theme.fg("dim", empty)}${theme.fg("dim", ` ${label}`)}`;
	}

	function compactMode(ctx: any): string {
		const model = ctx.model;
		if (!model) return "chat";
		// Keep it compact: provider/model-id is often too wide for the right side.
		return model.name || model.id || model.provider || "chat";
	}

	pi.on("agent_start", () => {
		isWorking = true;
		stopSpinner();
		spinnerTimer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
			activeTui?.requestRender();
		}, 120);
		activeTui?.requestRender();
	});

	pi.on("agent_end", () => {
		isWorking = false;
		stopSpinner();
		activeTui?.requestRender();
	});

	pi.on("model_select", () => {
		void refreshCodexUsage(true);
		activeTui?.requestRender();
	});
	pi.on("turn_end", () => {
		void refreshCodexUsage(true);
		activeTui?.requestRender();
	});
	pi.on("session_shutdown", () => {
		stopSpinner();
		if (usageTimer) {
			clearInterval(usageTimer);
			usageTimer = undefined;
		}
		activeTui = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
		void refreshCodexUsage(true);
		usageTimer ??= setInterval(() => void refreshCodexUsage(), 180_000);

		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsubscribeBranch,
				invalidate() {},

				render(width: number): string[] {
					const path = theme.fg("accent", fishPath(ctx.cwd));
					const branch = footerData.getGitBranch();
					const branchText = branch ? theme.fg("muted", ` [${branch}]`) : "";
					const sep = theme.fg("dim", "  ");
					const sessionName = pi.getSessionName?.();
					const sessionText = sessionName ? theme.fg("muted", sessionName) + sep : "";
					const left = path + branchText + sep + sessionText + contextBar(ctx, theme);

					const mode = compactMode(ctx);
					const reasoning = pi.getThinkingLevel();
					const spinner = isWorking ? theme.fg("accent", `${spinnerFrames[spinnerIndex]} `) : "";
					const usage = codexUsageText ? theme.fg("dim", `${modelUsageSeparator}${codexUsageText}`) : "";
					const right = spinner + theme.fg("muted", `${mode} (${reasoning})`) + usage;

					let leftText = left;
					let rightText = right;
					const minGap = 2;

					while (visibleWidth(leftText) + visibleWidth(rightText) + minGap > width && visibleWidth(leftText) > 0) {
						leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "…");
					}
					while (visibleWidth(leftText) + visibleWidth(rightText) + minGap > width && visibleWidth(rightText) > 0) {
						rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
					}

					const gap = " ".repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)));
					return [truncateToWidth(leftText + gap + rightText, width)];
				},
			};
		});
	});
}
