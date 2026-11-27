/** Minimal deterministic BM25 (k1=1.2, b=0.75). */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.'’]/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}
const STOP = new Set("the of and a an to in is for that be we let then if with on as by are this it any all there exists".split(" "));

export class Bm25 {
  private docs: string[][];
  private df = new Map<string, number>();
  private avgdl: number;
  constructor(docs: string[], private k1 = 1.2, private b = 0.75) {
    this.docs = docs.map(tokenize);
    for (const d of this.docs) for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgdl = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
  }
  score(query: string): number[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    return this.docs.map((d) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / (this.avgdl || 1)));
      }
      return s;
    });
  }
  topK(query: string, k: number): { index: number; score: number }[] {
    return this.score(query)
      .map((score, index) => ({ index, score }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, k);
  }
}
