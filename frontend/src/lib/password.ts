/** Rules for a NEW password (sign-up). Keep in step with password_problems() in core/auth/service.py. */

export const MIN_PASSWORD = 8;

export interface PasswordRule {
  id: "length" | "number" | "special";
  label: string; // shown in the checklist ("At least 8 characters")
  phrase: string; // used inside the error sentence ("at least 8 characters")
  ok: boolean;
}

export function passwordRules(password: string): PasswordRule[] {
  return [
    { id: "length", label: `At least ${MIN_PASSWORD} characters`, phrase: `at least ${MIN_PASSWORD} characters`, ok: password.length >= MIN_PASSWORD },
    { id: "number", label: "At least 1 number", phrase: "at least 1 number", ok: /[0-9]/.test(password) },
    // anything that isn't a letter, digit or space (underscore counts)
    { id: "special", label: "At least 1 special character", phrase: "at least 1 special character", ok: /[^\p{L}\p{N}\s]/u.test(password) },
  ];
}

/** "Password should have at least 1 number and at least 1 special character." - or "" when the password is fine. */
export function passwordError(password: string): string {
  const missing = passwordRules(password)
    .filter((r) => !r.ok)
    .map((r) => r.phrase);
  if (!missing.length) return "";
  const listed = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Password should have ${listed}.`;
}
