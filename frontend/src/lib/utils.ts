export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Speaker colours rotate: lime, cyan, amber, pink. */
const SPEAKER_COLOURS = ["#CCFF00", "#00F0FF", "#FF9900", "#F472B6"];
export function speakerColour(index: number): string {
  return SPEAKER_COLOURS[index % SPEAKER_COLOURS.length];
}
