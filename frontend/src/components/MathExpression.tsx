import { memo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

function MathExpression({ expression, display = false }: { expression: string; display?: boolean }) {
  let html: string | null = null;
  if (expression.length <= 12000) {
    try {
      html = katex.renderToString(expression, {
        displayMode: display,
        output: "htmlAndMathml",
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxExpand: 1000,
        maxSize: 20,
      });
    } catch {
      // Incomplete or unsupported output must never interrupt a streaming answer.
    }
  }

  const className = display ? "math-expression math-display studio-scroll" : "math-expression math-inline";
  if (html === null) return <span className={`${className} whitespace-pre-wrap`}>{expression}</span>;

  // Only KaTeX-generated markup is inserted. Raw model HTML is never accepted, and trust stays off.
  return <span className={className} data-testid={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

export default memo(MathExpression);
