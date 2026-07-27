/**
 * terminal-text.ts — stateless ANSI / control-character sanitization.
 *
 * Single source for the terminal-text cleaning rules that OCR result parsing,
 * OCR command-summary rendering, and the review TUI previously duplicated.
 * Two explicit semantics are exposed:
 *
 *  - `keepNewlines: true`  — preserve LF (and TAB) so multi-line review text
 *    stays readable. Used for OCR JSON body and preview compaction.
 *  - `keepNewlines: false` (default) — strip every C0/C1 control character
 *    including newlines and tabs. Used for single-line command summaries and
 *    TUI input values where a stray newline would break layout or quoting.
 *
 * ANSI escape handling is identical in both modes: CSI, OSC/DCS/PM/APC, SOS,
 * and the single-shift / string-terminator forms are removed.
 */

/** Match the ANSI escape sequences we strip in both modes. */
const ANSI_ESCAPE_RE =
	/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|P[^\x1B]*(?:\x1B\\)|[\^_][^\x1B]*(?:\x1B\\))/g;

/**
 * Strip ANSI escape sequences and C0/C1 control characters.
 *
 * `keepNewlines` defaults to false (remove all control chars including LF/CR/TAB).
 * Pass `true` to preserve line breaks and tabs so multi-line text stays readable.
 */
export function stripTerminalControl(
	s: string,
	options: { keepNewlines?: boolean } = {},
): string {
	const keepNewlines = options.keepNewlines ?? false;
	// Remove ANSI escapes first, then control characters.
	if (keepNewlines) {
		// Preserve LF (\x0A) and TAB (\x09); strip the rest of C0/C1.
		return s
			.replace(ANSI_ESCAPE_RE, "")
			.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, "");
	}
	return s
		.replace(ANSI_ESCAPE_RE, "")
		.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
}