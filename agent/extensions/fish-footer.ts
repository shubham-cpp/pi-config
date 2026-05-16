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
	const spinnerFrames = ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥"];

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

	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("turn_end", () => activeTui?.requestRender());
	pi.on("session_shutdown", () => {
		stopSpinner();
		activeTui = undefined;
	});

	pi.on("session_start", async (_event, ctx) => {
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
					const right = spinner + theme.fg("muted", `${mode} (${reasoning})`);

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
