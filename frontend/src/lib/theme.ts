import { useSyncExternalStore } from "react";

/* Appearance: day / night / system, and the accent colour. Chosen in Settings, kept in this browser's
 * localStorage, and applied by setting `data-theme` and two CSS variables on <html> (see index.css).
 * The small script in index.html applies the saved choice before the page paints, so there's no flash. */

export type Mode = "light" | "dark" | "system";

export interface Accent {
  id: string;
  name: string;
  dark: string; // the colour in night mode (bright, on a dark page)
  light: string; // the colour in day mode (deeper, so it reads on white)
}

export const ACCENTS: Accent[] = [
  { id: "copper", name: "Copper", dark: "#E7A080", light: "#99502E" },
  { id: "lime", name: "Lime", dark: "#CCFF00", light: "#4F7A00" },
  { id: "blue", name: "Blue", dark: "#4DA3FF", light: "#1D63D6" },
  { id: "green", name: "Green", dark: "#34D399", light: "#0A7F4F" },
  { id: "yellow", name: "Yellow", dark: "#FFD60A", light: "#8A6200" },
  { id: "orange", name: "Orange", dark: "#FF9F1C", light: "#B84F00" },
  { id: "red", name: "Red", dark: "#FF5A5F", light: "#D32F2F" },
  { id: "pink", name: "Pink", dark: "#FF6FB5", light: "#C2185B" },
  { id: "purple", name: "Purple", dark: "#B197FC", light: "#6D3FD6" },
];

export const CUSTOM = "custom";
const KEY = "finesse.theme.v1";
const DEFAULT_CUSTOM = "#7C5CFF";

export interface ThemeChoice {
  mode: Mode;
  accent: string; // an ACCENTS id, or "custom"
  custom: string; // the colour picked when accent is "custom"
}

export interface ThemeState extends ThemeChoice {
  resolved: "light" | "dark"; // what is on screen (system -> the OS setting)
  accentColor: string; // the accent as shown right now
}

/* ---- colour maths (WCAG contrast) ---------------------------------------------------------- */

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const toRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const toHex = (rgb: number[]) => `#${rgb.map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`;
const mix = (hex: string, toward: string, amount: number) => {
  const a = toRgb(hex);
  const b = toRgb(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Black or white, whichever reads better on this colour. */
const onColour = (hex: string) => (contrast(hex, "#000000") >= contrast(hex, "#FFFFFF") ? "#000000" : "#FFFFFF");

/** Darken a colour until it reads as text on a white page. */
function forLight(hex: string): string {
  let out = hex;
  for (let i = 0; i < 20 && contrast(out, "#FFFFFF") < 4.5; i++) out = mix(out, "#000000", 0.1);
  return out;
}
/** Lighten a colour until it reads as text on the dark page. */
function forDark(hex: string): string {
  let out = hex;
  for (let i = 0; i < 20 && contrast(out, "#1B1C1A") < 4.5; i++) out = mix(out, "#FFFFFF", 0.1);
  return out;
}

export const isHex = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

function variants(choice: ThemeChoice) {
  const preset = ACCENTS.find((a) => a.id === choice.accent);
  const dark = preset ? preset.dark : forDark(isHex(choice.custom) ? choice.custom : DEFAULT_CUSTOM);
  const light = preset ? preset.light : forLight(isHex(choice.custom) ? choice.custom : DEFAULT_CUSTOM);
  return { dark: { accent: dark, on: onColour(dark) }, light: { accent: light, on: onColour(light) } };
}

/* ---- the store ----------------------------------------------------------------------------- */

const systemQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
const resolveMode = (mode: Mode): "light" | "dark" => (mode === "system" ? (systemQuery?.matches ? "light" : "dark") : mode);

function read(): ThemeChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && typeof saved === "object") {
      const mode: Mode = saved.mode === "light" || saved.mode === "system" ? saved.mode : "dark";
      const accent = ACCENTS.some((a) => a.id === saved.accent) || saved.accent === CUSTOM ? saved.accent : "copper";
      return { mode, accent, custom: isHex(saved.custom) ? saved.custom : DEFAULT_CUSTOM };
    }
  } catch {
    /* storage blocked or corrupt: use the defaults */
  }
  return { mode: "dark", accent: "copper", custom: DEFAULT_CUSTOM };
}

function build(choice: ThemeChoice): ThemeState {
  const resolved = resolveMode(choice.mode);
  return { ...choice, resolved, accentColor: variants(choice)[resolved].accent };
}

function paint(state: ThemeState) {
  const root = document.documentElement;
  const v = variants(state)[state.resolved];
  root.dataset.theme = state.resolved;
  root.style.setProperty("--color-lime", v.accent);
  root.style.setProperty("--color-on-accent", v.on);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.resolved === "light" ? "#F7F5F0" : "#1B1C1A");
}

let state: ThemeState = build(read());
const listeners = new Set<() => void>();

function commit(choice: ThemeChoice) {
  state = build(choice);
  paint(state);
  try {
    // the variants are saved too, so the script in index.html can paint without any of the maths above
    localStorage.setItem(KEY, JSON.stringify({ ...choice, ...variants(choice) }));
  } catch {
    /* storage blocked: the choice just won't be remembered */
  }
  listeners.forEach((l) => l());
}

/** Call once at startup (main.tsx): paints the saved choice and follows the OS setting while on "system". */
export function initTheme() {
  paint(state);
  systemQuery?.addEventListener("change", () => {
    if (state.mode !== "system") return;
    state = build(state);
    paint(state);
    listeners.forEach((l) => l());
  });
}

export function setMode(mode: Mode) {
  commit({ mode, accent: state.accent, custom: state.custom });
}
export function setAccent(id: string) {
  commit({ mode: state.mode, accent: id, custom: state.custom });
}
export function setCustomColor(hex: string) {
  if (isHex(hex)) commit({ mode: state.mode, accent: CUSTOM, custom: hex });
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
