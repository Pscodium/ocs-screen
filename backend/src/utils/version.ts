// Compara versões semver simples `X.Y.Z` (sufixo depois de `-`/`+` é ignorado). Retorna negativo se
// a < b, 0 se iguais, positivo se a > b. Versão malformada conta como 0.0.0.
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(/[-+]/)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
