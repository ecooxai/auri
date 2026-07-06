import { EditorState } from "@codemirror/state";
import { EditorView, basicSetup } from "codemirror";

export function createTextEditor(parent, text = "") {
  const view = new EditorView({
    state: EditorState.create({ doc: text, extensions: [basicSetup] }),
    parent
  });

  return {
    getContent: () => view.state.doc.toString(),
    destroy: () => view.destroy()
  };
}
