// Plugin-side input validators (arch §7.1 layer 6).
//
// Defense-in-depth checks that run at the start of every tool's `execute()`,
// BEFORE any daemon HTTP call. The daemon has its own validators
// (`safeProjectPath`, the `^TASK_\d{4}_\d{3}$` task-id regex); these
// belt-and-brace those so a misconfigured chat model never even reaches the
// daemon with a path-traversal payload.

export const MAX_TEXT_LENGTH = 50_000;

/**
 * Reject path-traversal characters and ASCII control chars in a project
 * slug. Returns an error message on rejection, or `null` if the slug is
 * clean. Per arch §7.1 layer 6.
 */
export function validateProjectSlug(project: string): string | null {
  if (project.length === 0) {
    return "project must be a non-empty string";
  }
  if (
    project.includes("..") ||
    project.includes("/") ||
    project.includes("\\")
  ) {
    return 'project slug must not contain "..", "/" or "\\"';
  }
  // ASCII control chars (0x00–0x1F and 0x7F) — typebox `minLength` doesn't
  // catch these and they have no business in a project slug.
  for (let i = 0; i < project.length; i++) {
    const code = project.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return "project slug must not contain control characters";
    }
  }
  return null;
}

const TASK_ID_RE = /^TASK_\d{4}_\d{3}$/;

/**
 * Reject anything not matching the canonical `TASK_YYYY_NNN` shape — the
 * same pattern the daemon validates server-side. Returns an error message
 * or `null`.
 */
export function validateTaskId(taskId: string): string | null {
  if (taskId.length === 0) {
    return "taskId must be a non-empty string";
  }
  if (!TASK_ID_RE.test(taskId)) {
    return 'taskId must match "^TASK_\\d{4}_\\d{3}$" (e.g. TASK_2026_001)';
  }
  return null;
}

/**
 * Trim and length-check a free-form text input (description/prompt/reason).
 * Returns `{ value, error: null }` on success, `{ value: '', error }` on
 * rejection.
 *
 * Rejects empty-after-trim and anything over MAX_TEXT_LENGTH (50_000 chars).
 */
export function validateText(
  raw: string,
  field: string,
): { value: string; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: "", error: `${field} must not be empty` };
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      value: "",
      error: `${field} exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
    };
  }
  return { value: trimmed, error: null };
}
