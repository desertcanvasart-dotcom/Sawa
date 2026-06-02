import React, { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { Bold, Italic, List, ListOrdered, Heading2, Link as LinkIcon, Undo2, Redo2 } from "lucide-react";

// WYSIWYG editor. Outputs sanitized-ish HTML via onChange(html).
// (StarterKit only renders a safe subset; we additionally strip on the server side later.)
export function RichText({ value, onChange, placeholder = "Write here…" }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: value || "",
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: { attributes: { class: "rt-content" } },
  });

  // Keep external value changes in sync (e.g. when opening the editor on an existing tour).
  useEffect(() => {
    if (editor && value !== undefined && value !== editor.getHTML()) {
      editor.commands.setContent(value || "", false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  if (!editor) return <div className="rt-shell rt-loading" />;

  const Btn = ({ active, onClick, title, children }) => (
    <button type="button" title={title} className={active ? "rt-btn active" : "rt-btn"}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}>{children}</button>
  );

  return (
    <div className="rt-shell">
      <div className="rt-toolbar">
        <Btn title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></Btn>
        <Btn title="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></Btn>
        <Btn title="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></Btn>
        <span className="rt-sep" />
        <Btn title="Bullet list" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></Btn>
        <Btn title="Numbered list" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></Btn>
        <span className="rt-sep" />
        <Btn title="Link" active={editor.isActive("link")} onClick={() => {
          const prev = editor.getAttributes("link").href;
          const url = window.prompt("Link URL", prev || "https://");
          if (url === null) return;
          if (url === "") editor.chain().focus().unsetLink().run();
          else editor.chain().focus().setLink({ href: url }).run();
        }}><LinkIcon size={15} /></Btn>
        <span className="rt-sep" />
        <Btn title="Undo" onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></Btn>
        <Btn title="Redo" onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></Btn>
      </div>
      <EditorContent editor={editor} className="rt-editor" data-placeholder={placeholder} />
    </div>
  );
}
