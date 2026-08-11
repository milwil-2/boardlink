// Boards display either the V-scale ("V5"), Font ("6C+", "7A"), or a compound "6C+/V5". Parses any
// of them to a V-scale integer, preferring an explicit V token when present.
export function parseVGrade(grade: string | undefined | null): number | undefined {
  if (!grade) return undefined;
  const g = grade.trim().toUpperCase();
  const v = g.match(/V(\d+)/);
  if (v) return Number(v[1]);
  const f = g.match(/^(\d+)([ABC])?(\+)?$/);
  if (f) return fontToV(Number(f[1]), f[2], f[3]);
  return undefined;
}

export function fontToV(num: number, letter?: string, plus?: string): number | undefined {
  const table: Record<string, number> = {
    "4": 0, "5": 1, "5+": 2,
    "6A": 3, "6A+": 3, "6B": 4, "6B+": 4, "6C": 5, "6C+": 5,
    "7A": 6, "7A+": 7, "7B": 8, "7B+": 8, "7C": 9, "7C+": 10,
    "8A": 11, "8A+": 12, "8B": 13, "8B+": 14, "8C": 15, "8C+": 16,
  };
  const key = `${num}${letter ?? ""}${plus ?? ""}`;
  return table[key] ?? table[`${num}${letter ?? ""}`] ?? table[String(num)];
}
