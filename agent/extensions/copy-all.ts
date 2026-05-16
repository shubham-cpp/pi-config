import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block)) return "";

      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      if (block.type === "image") return "[image]";

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

type ClipboardCommand = {
  command: "pbcopy" | "wl-copy";
  args: string[];
};

const CLIPBOARD_COMMANDS: ClipboardCommand[] =
  process.platform === "darwin"
    ? [
        { command: "pbcopy", args: [] },
        { command: "wl-copy", args: ["--type", "text/plain"] },
      ]
    : [
        { command: "wl-copy", args: ["--type", "text/plain"] },
        { command: "pbcopy", args: [] },
      ];

function isMissingProgram(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function copyWithCommand({ command, args }: ClipboardCommand, text: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.stdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finish(error);
    });

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(new Error(stderr.trim() || `${command} exited with code ${code}`));
      }
    });

    child.stdin.end(text);
  });
}

async function copyToClipboard(text: string) {
  const missing: string[] = [];

  for (const clipboardCommand of CLIPBOARD_COMMANDS) {
    try {
      await copyWithCommand(clipboardCommand, text);
      return;
    } catch (error) {
      if (isMissingProgram(error)) {
        missing.push(clipboardCommand.command);
        continue;
      }

      throw error;
    }
  }

  if (missing.length === CLIPBOARD_COMMANDS.length) {
    throw new Error("cannot copy because program not found: pbcopy, wl-copy");
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description:
      "Copy all previous user and assistant messages in this thread to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const messages = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message)
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        );

      const text = messages
        .map((message) => {
          const content = textFromContent(message.content).trim();
          return `${message.role.toUpperCase()}:\n${content}`;
        })
        .filter((section) => !section.endsWith(":\n"))
        .join("\n\n---\n\n");

      if (!text) {
        ctx.ui.notify("No user or assistant messages to copy", "info");
        return;
      }

      try {
        await copyToClipboard(text);
        ctx.ui.notify(`Copied ${messages.length} messages to clipboard`, "info");
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "cannot copy to clipboard",
          "error",
        );
      }
    },
  });
}
