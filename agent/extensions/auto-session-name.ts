import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TITLE_SYSTEM_PROMPT = `You name coding-agent sessions.
Infer the user's actual task/intent from their first prompt and produce a short, useful session title.
Rules:
- 2 to 6 words.
- Title Case or concise sentence case is fine.
- No quotes, no trailing punctuation.
- Do not mention "session", "chat", or "prompt".
- Prefer task intent over literal wording.
Examples:
User: "can you check whether this smart fetch repo is safe?" -> Smart Fetch Security Audit
User: "fix the navbar on mobile and clean up the css" -> Fix Mobile Navbar
User: "how does auth middleware work here" -> Understand Auth Middleware`;

function cleanTitle(raw: string): string {
	let title = raw
		.split("\n")[0]
		.trim()
		.replace(/^title\s*:\s*/i, "")
		.replace(/^[-*\d.)\s]+/, "")
		.replace(/["'`]/g, "")
		.replace(/[.!?;:]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	const words = title.split(" ").filter(Boolean);
	if (words.length > 7) title = words.slice(0, 7).join(" ");
	if (title.length > 48) title = `${title.slice(0, 45).trim()}…`;
	return title;
}

function fallbackTitle(prompt: string): string {
	return cleanTitle(prompt).split(" ").slice(0, 6).join(" ") || "New Task";
}

export default function autoSessionName(pi: ExtensionAPI) {
	let attempted = false;

	pi.on("before_agent_start", async (event, ctx) => {
		if (attempted || pi.getSessionName?.()) return;
		attempted = true;

		const prompt = event.prompt.trim();
		if (!prompt) return;

		const candidates: Array<[provider: string, id: string]> = [
			// Prefer OpenAI Codex subscription models.
			["openai-codex", "gpt-5.4-mini"],
			["openai-codex", "gpt-5.2-codex-mini"],
			["openai-codex", "gpt-5.1-codex-mini"],
			// API-key fallbacks, in case the Codex catalog name changes.
			["openai", "gpt-5.2-mini"],
			["openai", "gpt-5-mini"],
		];

		const model = candidates
			.map(([provider, id]) => ctx.modelRegistry.find(provider, id))
			.find(Boolean);

		if (!model) {
			pi.setSessionName(fallbackTitle(prompt));
			return;
		}

		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				pi.setSessionName(fallbackTitle(prompt));
				return;
			}

			const response = await complete(
				model,
				{
					systemPrompt: TITLE_SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 32,
					reasoningEffort: "minimal",
					signal: ctx.signal,
				},
			);

			const text = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			pi.setSessionName(cleanTitle(text) || fallbackTitle(prompt));
		} catch {
			pi.setSessionName(fallbackTitle(prompt));
		}
	});
}
