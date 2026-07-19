import CodeBlockLowlight, { type CodeBlockLowlightOptions } from "@tiptap/extension-code-block-lowlight";

interface MermaidLike {
  initialize(config: { startOnLoad: boolean; theme?: string }): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaid: MermaidLike | null = null;
let loading: Promise<MermaidLike> | null = null;
let mermaidId = 0;

// Mermaid (~600 KB+) loads only when a note actually contains a ```mermaid block.
function ensureMermaid(): Promise<MermaidLike> {
  if (mermaid) return Promise.resolve(mermaid);
  if (!loading) {
    loading = import("mermaid").then((mod) => {
      const m = mod as unknown as { default?: MermaidLike } & MermaidLike;
      mermaid = m.default ?? m;
      return mermaid;
    });
  }
  return loading;
}

interface MermaidOptions extends CodeBlockLowlightOptions {
  /** Render ```mermaid blocks as diagrams. When false they fall through to the
   *  plain `<pre><code>` NodeView and mermaid never lazy-loads. The extension
   *  itself must stay registered either way — it is the schema's only
   *  codeBlock node. */
  renderDiagrams: boolean;
  mermaidShowSource: string;
  mermaidShowDiagram: string;
}

/** CodeBlockLowlight + a NodeView. Non-mermaid blocks render a normal
 *  `<pre><code>` (so lowlight highlighting + editing are unchanged); a
 *  ```mermaid block renders the diagram with a raw/rendered toggle. The block
 *  stays a plain fenced code block, so the Markdown round-trips untouched. */
export const MermaidCodeBlock = CodeBlockLowlight.extend<MermaidOptions>({
  addOptions() {
    return {
      ...this.parent?.(),
      renderDiagrams: true,
      mermaidShowSource: "Show source",
      mermaidShowDiagram: "Show diagram",
    };
  },

  addNodeView() {
    const options = this.options;

    return ({ node }) => {
      // Plain code block: reproduce the default <pre><code> so the lowlight
      // decoration plugin highlights it exactly as before. With diagram
      // rendering off, ```mermaid blocks take this branch too.
      if (node.attrs.language !== "mermaid" || !options.renderDiagrams) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (node.attrs.language) code.className = `language-${node.attrs.language}`;
        pre.appendChild(code);
        return {
          dom: pre,
          contentDOM: code,
          update: (updated) => {
            if (updated.type !== node.type) return false;
            if (updated.attrs.language === "mermaid" && options.renderDiagrams) return false; // became mermaid → rebuild
            code.className = updated.attrs.language ? `language-${updated.attrs.language}` : "";
            return true;
          },
        };
      }

      let currentNode = node;
      let mode: "diagram" | "source" = "diagram";

      const wrap = document.createElement("div");
      wrap.className = "nv-mermaid-block";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "nv-mermaid-toggle";
      toggle.contentEditable = "false";

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.className = "language-mermaid";
      pre.appendChild(code);

      const diagram = document.createElement("div");
      diagram.className = "nv-mermaid";
      diagram.contentEditable = "false";

      wrap.append(toggle, pre, diagram);

      const renderDiagram = () => {
        const src = currentNode.textContent.trim();
        if (!src) {
          diagram.innerHTML = "";
          return;
        }
        void ensureMermaid().then(async (mm) => {
          const isLight = document.documentElement.getAttribute("data-theme") === "light";
          mm.initialize({ startOnLoad: false, theme: isLight ? "default" : "dark" });
          try {
            const { svg } = await mm.render(`nv-mermaid-${mermaidId++}`, src);
            diagram.innerHTML = svg;
          } catch (err) {
            diagram.innerHTML = "";
            const e = document.createElement("div");
            e.className = "nv-mermaid-error";
            e.textContent = err instanceof Error ? err.message : String(err);
            diagram.appendChild(e);
          }
        });
      };

      const apply = () => {
        if (mode === "diagram") {
          pre.style.display = "none";
          diagram.style.display = "block";
          toggle.textContent = options.mermaidShowSource;
          renderDiagram();
        } else {
          pre.style.display = "block";
          diagram.style.display = "none";
          toggle.textContent = options.mermaidShowDiagram;
        }
      };

      toggle.addEventListener("mousedown", (e) => e.preventDefault());
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        mode = mode === "diagram" ? "source" : "diagram";
        apply();
      });

      apply();

      return {
        dom: wrap,
        contentDOM: code,
        update: (updated) => {
          if (updated.type !== currentNode.type) return false;
          if (updated.attrs.language !== "mermaid") return false; // no longer mermaid → rebuild
          currentNode = updated;
          if (mode === "diagram") renderDiagram();
          return true;
        },
        ignoreMutation: (mutation) => !code.contains(mutation.target as Node),
      };
    };
  },
});
