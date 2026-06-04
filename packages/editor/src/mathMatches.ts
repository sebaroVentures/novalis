export interface MathMatch {
  from: number;
  to: number;
  content: string;
  display: boolean;
}

// Block `$$…$$` (tried first) or inline `$…$` with no space just inside the
// delimiters — so "$5 and $10" is not mistaken for math.
const MATH_RE = /\$\$([^$]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

/** Find inline and block math spans within a single text node's string. Pure. */
export function findMath(text: string): MathMatch[] {
  const out: MathMatch[] = [];
  MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_RE.exec(text)) !== null) {
    if (m[1] !== undefined) {
      out.push({ from: m.index, to: m.index + m[0].length, content: m[1], display: true });
    } else {
      out.push({ from: m.index, to: m.index + m[0].length, content: m[2], display: false });
    }
  }
  return out;
}
