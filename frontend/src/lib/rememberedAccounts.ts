const KEY = "finesse.accounts.v1";

export type RememberedAccount = {
  name: string;
  email: string;
  provider: "google" | "password";
};

function read(): RememberedAccount[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RememberedAccount[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item?.email && item?.name).slice(0, 8);
  } catch {
    return [];
  }
}

export function listAccounts(): RememberedAccount[] {
  return read();
}

export function rememberAccount(account: RememberedAccount) {
  const email = account.email.trim().toLowerCase();
  const next = [{ ...account, email }, ...read().filter((item) => item.email !== email)].slice(0, 8);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

export function forgetAccount(email: string) {
  const key = email.trim().toLowerCase();
  try {
    localStorage.setItem(KEY, JSON.stringify(read().filter((item) => item.email !== key)));
  } catch {
    /* private mode */
  }
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
