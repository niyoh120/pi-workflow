import type { Mode, WorkflowState } from "./types.js";

/** Returns true if the given mode does not allow local file mutations. */
export function isReadonlyMode(mode: Mode): boolean {
  return mode === "planning" || mode === "planReview" || mode === "review";
}

/** Check whether a shell command would modify local files. */
export function isLocalFileMutatingShell(command: string): boolean {
  const cmd = command.trim();
  if (cmd.length === 0) return false;

  // Shell redirection / tee / patch usually writes files.
  if (/(^|[^<])>\s*[^&]/.test(cmd)) return true;
  if (/>>\s*/.test(cmd)) return true;
  if (/\|\s*tee\b/.test(cmd)) return true;
  if (/\bapply_patch\b/.test(cmd)) return true;

  const mutatingPatterns = [
    /^rm\b/,
    /^mv\b/,
    /^cp\b/,
    /^touch\b/,
    /^mkdir\b/,
    /^rmdir\b/,
    /^chmod\b/,
    /^chown\b/,
    /^ln\b/,
    /^truncate\b/,

    /\bprettier\b.*\s--write\b/,
    /\beslint\b.*\s--fix\b/,
    /\bruff\b.*\s--fix\b/,
    /\bblack\b/,
    /\bgofmt\b.*\s-w\b/,
    /\brustfmt\b/,

    /^npm\s+(install|i|add|update|dedupe|link|uninstall|remove|rm)\b/,
    /^pnpm\s+(install|add|update|link|remove|rm)\b/,
    /^yarn\s+(install|add|upgrade|link|remove)\b/,
    /^bun\s+(install|add|update|remove|rm)\b/,
    /^pip\s+install\b/,
    /^uv\s+add\b/,
    /^poetry\s+add\b/,
    /^cargo\s+add\b/,
    /^go\s+get\b/,

    /^git\s+(add|commit|checkout|switch|reset|clean|apply|restore|merge|rebase|cherry-pick|stash|tag|push)\b/,
    /^git\s+branch\s+(-d|-D|-m)\b/,
  ];

  return mutatingPatterns.some((re) => re.test(cmd));
}

/** Check whether a shell command is allowed in Commit mode (git read/write only). */
export function isCommitAllowedShell(command: string): boolean {
  const cmd = command.trim();

  return [
    /^git\s+status\b/,
    /^git\s+diff\b/,
    /^git\s+add\b/,
    /^git\s+commit\b/,
    /^git\s+rev-parse\b/,
    /^git\s+log\b/,
    /^git\s+show\b/,
  ].some((re) => re.test(cmd));
}

/** Extract all assistant message text from an agent_end event. */
export function extractAssistantText(event: any): string {
  return (event.messages ?? [])
    .filter((m: any) => m.role === "assistant")
    .map((m: any) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content.map((p: any) => p.text ?? "").join("\n");
      }
      return "";
    })
    .join("\n");
}
