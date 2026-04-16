# Building a collaborative WYSIWYG + source code editor on Yjs

**The core architectural challenge is that Yjs's two primary editor bindings use incompatible data types — y-prosemirror requires `Y.XmlFragment` (a tree) while y-codemirror.next requires `Y.Text` (a flat string) — making simultaneous collaborative editing across both views impractical.** The proven production approach, used by Outline, Milkdown, and AFFiNE, treats Y.XmlFragment as the canonical CRDT layer for WYSIWYG editing and serializes to text only on view switch or export. This report covers the full architecture: editor selection, Markdown fidelity, hybrid view switching, embedded code blocks, and web component packaging with enterprise-grade guidance.

---

## Tiptap v3 on ProseMirror is the strongest foundation

Among the six editors evaluated — ProseMirror, Tiptap, Lexical, BlockNote, Milkdown, and Plate — **Tiptap v3 atop ProseMirror offers the most mature Yjs integration, the richest extension ecosystem, and the best HTML handling**. Released as stable in July 2025, Tiptap v3 now ships `@tiptap/y-tiptap` (extending y-prosemirror) and `@tiptap/extension-collaboration` for turnkey CRDT setup. At **~9 million npm downloads/month**, it represents the dominant choice.

The Yjs binding works by mapping ProseMirror's immutable document tree to a `Y.XmlFragment`. Each block node (paragraph, heading, code block) becomes a `Y.XmlElement`; inline text becomes `Y.XmlText` with formatting attributes for marks like bold and italic. The `ySyncPlugin` creates a bidirectional binding — ProseMirror transactions produce Yjs mutations, and remote Yjs updates produce ProseMirror transactions — coordinated through a `ProsemirrorMapping` that tracks element correspondence and a mutex preventing re-entrant updates.

```javascript
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const ydoc = new Y.Doc()
const provider = new WebsocketProvider('wss://collab.example.com', 'doc-room', ydoc)

const editor = new Editor({
  extensions: [
    StarterKit.configure({ undoRedo: false }), // disable built-in history
    Collaboration.configure({ document: ydoc }),
    CollaborationCaret.configure({
      provider,
      user: { name: 'Alice', color: '#e06c75' },
    }),
  ],
})
```

The alternatives serve narrower use cases. **Lexical** (Meta) has an official `@lexical/yjs` binding but hardcodes a single root node name per Y.Doc and lacks ProseMirror's decoration system, forcing cursor overlays via HTML repositioning. **BlockNote** builds on Tiptap/ProseMirror and adds Notion-like block-based editing with built-in Yjs utilities (`blocksToYDoc`, `yDocToBlocks`), making it ideal for block-centric UIs but less flexible for arbitrary HTML. **Milkdown** is purpose-built for Markdown WYSIWYG via remark/unified, but its collaboration plugin is less actively maintained. **Plate** (Slate-based) suffers from `slate-yjs` maintenance slowdown and Slate's lack of enforced schema, making concurrent editing riskier.

| Editor | Yjs Binding | Maturity | Document Model | Best For |
|--------|------------|----------|---------------|----------|
| **Tiptap v3** | `@tiptap/extension-collaboration` | ★★★★★ | ProseMirror schema via extensions | General-purpose, HTML-rich editing |
| **ProseMirror** | `y-prosemirror` | ★★★★★ | Schema-defined nodes + marks | Maximum control, custom schemas |
| **Lexical** | `@lexical/yjs` | ★★★☆☆ | Class-based node tree | React-native apps |
| **BlockNote** | `y-prosemirror` (via Tiptap) | ★★★★☆ | Typed block schemas | Notion-like block editors |
| **Milkdown** | `@milkdown/plugin-collab` | ★★★☆☆ | ProseMirror (remark-derived) | Markdown-first WYSIWYG |
| **Plate/Slate** | `slate-yjs` | ★★☆☆☆ | JSON tree, no enforced schema | Avoid for collaboration |

For **permissive HTML editing** — supporting custom elements, inline styles, data attributes, and complex nesting — Tiptap's extension system is the most ergonomic. Each extension declares `addAttributes()` for automatic DOM serialization, `parseHTML()` rules for ingestion, and `renderHTML()` for output. ProseMirror's underlying `DOMParser` and `DOMSerializer` APIs handle the heavy lifting, but the schema is strict: content that doesn't match a declared node type is discarded. A "permissive" schema requires explicitly defining generic block/inline node types with catch-all attribute storage. The key limitation is that **ProseMirror nodes must contain either all block children or all inline children** — mixed content is normalized.

---

## Markdown round-trip fidelity requires accepting normalization

WYSIWYG Markdown editing faces a fundamental tension: ProseMirror's document model is **semantic** (it knows "this is emphasized"), not **syntactic** (it doesn't know "this was `*emphasized*` vs `_emphasized_`"). Round-tripping Markdown through a ProseMirror document normalizes formatting choices — `_em_` becomes `*em*`, setext headings become ATX headings, reference-style links become inline links, and whitespace is collapsed.

Three parsing/serialization stacks compete for this space. The **remark/unified ecosystem** offers the best extensibility through its AST-based pipeline (`Markdown → remark-parse → mdast → transforms → remark-stringify`), and Milkdown chose it specifically because "markdown-it prioritizes HTML output, while remark has first-class support for abstract syntax trees." The newer `@handlewithcare/remark-prosemirror` library, endorsed by ProseMirror's author Marijn Haverbeke, provides a clean bridge between mdast and ProseMirror documents. **Tiptap's official `@tiptap/markdown`** (v3.7.0+) uses MarkedJS as its lexer and lets each extension define `parseMarkdown`/`renderMarkdown` handlers, making it the easiest path within the Tiptap ecosystem. The legacy **prosemirror-markdown** package wraps markdown-it but is harder to extend and explicitly doesn't parse inline HTML.

For collaborative Markdown editing, **the proven architecture stores Y.XmlFragment (the rich-text tree) as the live CRDT, not raw Markdown text**. Outline, Milkdown, and Open WebUI all follow this pattern. Markdown is the import/export/persistence format — parsed on load, serialized on save — but the CRDT operates on the structured tree, giving structure-aware conflict resolution where two users editing different list items won't produce character-level conflicts. The Outline team confirmed this directly: "it doesn't seem feasible to programmatically change the underlying markdown document as this would require serializing and de-serializing, losing the state of the internal sync tree."

Handling **frontmatter** and **raw HTML blocks** within Markdown requires custom ProseMirror node types. The recommended approach defines a `frontmatter` node that stores raw YAML as a string attribute and renders as a collapsible code block, and an `html_block` node that preserves raw HTML verbatim. These serialize back with their original fences:

```javascript
const Frontmatter = Node.create({
  name: 'frontmatter',
  group: 'block',
  atom: true,
  addAttributes() {
    return { content: { default: '' } }
  },
  parseHTML() { return [{ tag: 'pre[data-frontmatter]' }] },
  renderHTML({ node }) {
    return ['pre', { 'data-frontmatter': '', class: 'frontmatter' }, node.attrs.content]
  },
})
```

---

## The exclusive-view strategy solves the WYSIWYG-to-source switching problem

The core incompatibility between y-prosemirror's `Y.XmlFragment` and y-codemirror.next's `Y.Text` rules out binding both editors to the same shared type simultaneously. Four strategies exist, with escalating complexity:

**Strategy A (Y.XmlFragment canonical, serialize to text for code view)** keeps ProseMirror bound to Yjs but renders the code view without CRDT collaboration. **Strategy B (Y.Text canonical, parse for WYSIWYG)** inverts this, giving collaboration to the code view but not WYSIWYG. **Strategy C (dual types with sync layer)** maintains both Y.XmlFragment and Y.Text with bidirectional conversion on every change — theoretically elegant but practically untenable because Markdown parsing isn't bijective, changes to different Yjs types from simultaneous editors can't be reconciled by the CRDT, and no production editor has shipped this. **Strategy D (exclusive views with serialization on switch)** is the recommended approach, following ProseMirror's own official example of toggling between a Markdown textarea and a WYSIWYG editor.

The enhanced version of Strategy D uses **Y.XmlFragment as the permanent canonical type** with a per-switch serialization step:

```
[User clicks "Source View"]
  → Serialize Y.XmlFragment → Markdown/HTML string
  → ydoc.transact(() => {
      ytext.delete(0, ytext.length)
      ytext.insert(0, serializedString)
    })
  → Unbind y-prosemirror, create CodeMirror with yCollab(ytext, awareness)
  → meta.set('activeView', 'source')  // signals all peers to switch

[User clicks "WYSIWYG View"]  
  → Parse ytext.toString() → ProseMirror JSON
  → ydoc.transact(() => { rebuild Y.XmlFragment from parsed doc })
  → Destroy CodeMirror, create ProseMirror with ySyncPlugin(xmlFragment)
```

The `activeView` flag lives in `Y.Map('meta')` within the same Y.Doc so all connected peers can coordinate their view state. Clearing and repopulating a Yjs type does reset undo history for that type — scope `Y.UndoManager` to whichever type is active and create a fresh instance on each switch. **CKEditor 5's SourceEditing plugin validates this approach**: their documentation explicitly warns that "after you switch to source editing, incoming changes performed by remote users are not reflected in the source code," confirming that pausing collaboration during source editing is an accepted industry pattern.

For a **read-only source preview** (no editing in source view), the implementation is simpler: observe Y.XmlFragment changes, debounce serialization to text, and display in a non-collaborative CodeMirror instance.

The recommended Y.Doc structure for multi-format documents:

```javascript
const ydoc = new Y.Doc()
const content    = ydoc.getXmlFragment('content')     // canonical rich-text tree
const sourceText = ydoc.getText('source')              // populated on view switch
const meta       = ydoc.getMap('meta')                 // format, language, activeView
const frontmatter = ydoc.getMap('frontmatter')         // YAML metadata, separate from content
```

---

## Embedding CodeMirror 6 inside rich-text code blocks

Syntax-highlighted code blocks within a WYSIWYG editor take two forms: **decoration-based** (lowlight/Shiki apply colored spans over plain ProseMirror text) and **embedded editor** (a full CodeMirror 6 instance renders as a ProseMirror NodeView). The choice depends on whether code blocks need editing features like auto-indent, bracket matching, and code folding.

The **decoration-based approach** is simpler and collaboration-ready out of the box. Tiptap's `@tiptap/extension-code-block-lowlight` tokenizes code via highlight.js, maps tokens to ProseMirror inline decorations, and recalculates on every document change. BlockNote uses Shiki (TextMate grammars, VS Code-quality highlighting) with `shiki-codegen` for optimized bundles. Both approaches store code as plain text within a `code_block` node — y-prosemirror maps this to a `Y.XmlText` child of a `Y.XmlElement`, and **cursors inside code blocks work identically to cursors in paragraphs** with no special handling needed.

The **CodeMirror 6 NodeView approach**, demonstrated in ProseMirror's official example and packaged in `prosemirror-codemirror-block` (by Emergence Engineering), creates a full CodeMirror instance per code block. The critical implementation details are:

- **Undo/redo delegation**: CodeMirror keybindings must invoke the outer ProseMirror's undo manager (or `yUndoPlugin`), never CodeMirror's built-in history
- **Cursor bridging**: Arrow-key handlers detect edge-of-content positions via `view.endOfTextblock(dir)` and transfer focus between CM and PM
- **Update synchronization**: An `updating` flag prevents infinite loops when remote changes flow through PM → CM → PM
- **Language lazy-loading**: `prosemirror-codemirror-block` supports dynamic language imports to avoid bundling all grammars

```javascript
// CodeMirror keymap inside the NodeView — delegates undo to y-prosemirror
codeMirrorKeymap() {
  return [
    { key: 'Mod-z', run: () => undo(this.pmView.state, this.pmView.dispatch) },
    { key: 'Mod-Shift-z', run: () => redo(this.pmView.state, this.pmView.dispatch) },
    { key: 'Mod-Enter', run: () => {
        exitCode(this.pmView.state, this.pmView.dispatch)
        this.pmView.focus()
        return true
    }},
  ]
}
```

Collaboration within embedded CodeMirror NodeViews works because the code block's text content is still part of the parent Y.XmlFragment tree — each code block's text is a `Y.XmlText` node, not an isolated `Y.Text`. Remote edits arrive as ProseMirror transactions that trigger the NodeView's `update()` method, which reconciles CodeMirror's state. However, **remote cursor rendering inside CM NodeViews is unreliable** because y-prosemirror's cursor decorations may not render correctly inside a NodeView managing its own DOM. For enterprise use, the decoration-based approach (lowlight or Shiki) avoids this complexity entirely.

| Highlighter | Approach | Languages | Bundle (gzip) | Best For |
|------------|----------|-----------|---------------|----------|
| **lowlight** | Regex, PM decorations | ~190 | ~37KB core | Simple code blocks, fast integration |
| **Shiki** | TextMate grammars, decorations | ~200+ | ~50KB + grammars | VS Code-quality highlighting, BlockNote |
| **CodeMirror 6 / Lezer** | Incremental LR parser, full editor | ~35 first-party | ~130KB core | Interactive code editing with IDE features |
| **Prism.js** | Regex, DOM-based | ~290 | ~2KB core | Read-only display (used by Notion) |

---

## Packaging as a framework-agnostic web component

Wrapping this multi-editor system as a single `<multi-editor>` web component requires handling Shadow DOM style isolation, editor lifecycle management, and collaboration provider coordination. **Lit** (~5KB gzipped) is the recommended web component base over Stencil or vanilla custom elements, providing reactive properties and declarative templates with minimal overhead.

Both editors support Shadow DOM with configuration. CodeMirror 6 has first-class support via the `root` option, which directs style injection into the shadow root using `adoptedStyleSheets`. Tiptap requires `injectCss: false` to prevent styles from targeting `document.head`, then manual style injection into the shadow root.

The critical lifecycle decision is **keeping both editors mounted but hiding the inactive one** rather than creating/destroying on mode switch. ProseMirror and CodeMirror initialization is expensive (schema parsing, plugin setup, DOM construction), while a hidden editor incurs negligible cost (`display: none` prevents layout and paint). Mode switching then reduces to toggling visibility, serializing content from one editor, and loading it into the other.

The API surface should expose primitive attributes for declarative HTML usage and complex objects as JavaScript properties:

```html
<multi-editor
  mode="wysiwyg"
  format="markdown"
  language="html"
  placeholder="Start writing..."
  theme="light"
  readonly
></multi-editor>

<script>
  const editor = document.querySelector('multi-editor');
  // Collaboration config as JS property (too complex for attributes)
  editor.collaboration = {
    enabled: true,
    roomName: 'doc-123',
    providerUrl: 'wss://collab.example.com',
    user: { name: 'Alice', color: '#e06c75' },
  };
  
  editor.addEventListener('editor-change', (e) => {
    console.log(e.detail.value, e.detail.format);
  });
  
  await editor.switchMode('source');
</script>
```

Key events to emit: `editor-change` (debounced content updates), `mode-change`, `editor-save` (Cmd+S capture), `collab-status` (connecting/connected/disconnected), and `before-mode-change` (cancellable, for unsaved-changes warnings). For React interop, `@lit/react`'s `createComponent` generates a typed wrapper that maps custom events to React callbacks. Vue, Angular, and Svelte consume custom elements natively.

The full bundle — Tiptap, ProseMirror core, CodeMirror 6, Yjs, bindings, and Lit — totals approximately **200–250KB gzipped**. Aggressive code-splitting via Rollup's `manualChunks` separates ProseMirror, CodeMirror, and Yjs into independent chunks. CodeMirror language grammars should be lazy-loaded via dynamic imports, deferring their cost until source mode is first activated or a specific code block language is selected.

---

## Conclusion

The viable architecture for a collaborative WYSIWYG + source editor converges on a **Tiptap v3/ProseMirror + CodeMirror 6 dual-editor system** sharing a single `Y.Doc`, with `Y.XmlFragment` as the canonical CRDT type and serialization-on-switch for source editing. Three non-obvious insights emerge from this research.

First, **the "both views collaboratively editable simultaneously" dream is architecturally impractical** given current CRDT tooling. The Yjs type mismatch between tree and text structures isn't a bug to fix — it reflects a fundamental data model difference. The industry consensus, from CKEditor to Outline, is to accept exclusive-view editing with serialization boundaries.

Second, **Markdown round-trip normalization is a feature, not a bug**, for collaborative editors. Storing the normalized rich-text tree (Y.XmlFragment) as the live CRDT provides structure-aware conflict resolution that character-level text CRDTs cannot match. Markdown purity is preserved at the persistence layer, not the collaboration layer.

Third, **decoration-based syntax highlighting (lowlight/Shiki) is the pragmatic choice over embedded CodeMirror 6 for code blocks** in collaborative environments. The CM6 NodeView approach delivers IDE-quality editing but introduces cursor bridging, undo delegation, and remote cursor rendering complexities that don't justify the UX improvement for most use cases. Reserve full CodeMirror embedding for source-mode editing of the entire document, not individual code blocks within rich text.