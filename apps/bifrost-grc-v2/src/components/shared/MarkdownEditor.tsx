import { useEffect, useRef, type CSSProperties, type MutableRefObject } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { Image } from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import {
  Bold,
  Columns3,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Rows3,
  Table2,
  Trash2,
  Undo2,
} from "lucide-react";
import { normalizeFactMarkers } from "../../lib/fact-markers";

interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  minHeight?: number;
  autoFocus?: boolean;
  focusHandleRef?: MutableRefObject<(() => void) | null>;
  onConfirm?: () => void;
  onPasteImage?: (file: File) => Promise<string | null>;
}

export default function MarkdownEditor({
  value,
  onChange,
  ariaLabel,
  disabled = false,
  minHeight = 132,
  autoFocus = false,
  focusHandleRef,
  onConfirm,
  onPasteImage,
}: MarkdownEditorProps) {
  const editorInstanceRef = useRef<Editor | null>(null);
  const pasteImageRef = useRef(onPasteImage);
  const userEditedRef = useRef(false);
  pasteImageRef.current = onPasteImage;
  const editor = useEditor({
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit,
      Image.configure({ allowBase64: false }),
      TableKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: value || "",
    contentType: "markdown",
    editable: !disabled,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        class: "cv-markdown-editor__content",
      },
      handleKeyDown: (_view, event) => {
        if (event.key.length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key)) userEditedRef.current = true;
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
          event.preventDefault();
          onConfirm?.();
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
        if (!image || !pasteImageRef.current) return false;
        userEditedRef.current = true;
        event.preventDefault();
        void pasteImageRef.current(image).then((markdown) => {
          if (markdown) editorInstanceRef.current?.chain().focus().insertContent(markdown, { contentType: "markdown" }).run();
        });
        return true;
      },
      handleTextInput: () => {
        userEditedRef.current = true;
        return false;
      },
      handleDrop: () => {
        userEditedRef.current = true;
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      if (userEditedRef.current) onChange(normalizeFactMarkers(current.getMarkdown()));
    },
  });

  useEffect(() => {
    editorInstanceRef.current = editor;
    return () => { editorInstanceRef.current = null; };
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor || !focusHandleRef) return;
    focusHandleRef.current = () => editor.commands.focus("end");
    return () => { focusHandleRef.current = null; };
  }, [editor, focusHandleRef]);

  useEffect(() => {
    if (!editor || !autoFocus) return;
    const timer = window.setTimeout(() => editor.commands.focus("end"), 90);
    return () => window.clearTimeout(timer);
  }, [autoFocus, editor]);

  useEffect(() => {
    if (!editor) return;
    const normalizedValue = normalizeFactMarkers(value);
    const current = normalizeFactMarkers(editor.getMarkdown());
    if (current !== normalizedValue) {
      userEditedRef.current = false;
      const content = normalizedValue && editor.markdown ? editor.markdown.parse(normalizedValue) : "";
      editor.commands.setContent(content, { emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) return <div className="cv-field" style={{ minHeight }} />;

  const runAsEdit = (command: () => void) => {
    userEditedRef.current = true;
    command();
  };

  const toolbar = [
    { label: "Bold", active: editor.isActive("bold"), run: () => runAsEdit(() => { editor.chain().focus().toggleBold().run(); }), icon: Bold },
    { label: "Italic", active: editor.isActive("italic"), run: () => runAsEdit(() => { editor.chain().focus().toggleItalic().run(); }), icon: Italic },
    { label: "Heading 2", active: editor.isActive("heading", { level: 2 }), run: () => runAsEdit(() => { editor.chain().focus().toggleHeading({ level: 2 }).run(); }), icon: Heading2 },
    { label: "Heading 3", active: editor.isActive("heading", { level: 3 }), run: () => runAsEdit(() => { editor.chain().focus().toggleHeading({ level: 3 }).run(); }), icon: Heading3 },
    { label: "Bullet list", active: editor.isActive("bulletList"), run: () => runAsEdit(() => { editor.chain().focus().toggleBulletList().run(); }), icon: List },
    { label: "Numbered list", active: editor.isActive("orderedList"), run: () => runAsEdit(() => { editor.chain().focus().toggleOrderedList().run(); }), icon: ListOrdered },
    { label: "Quote", active: editor.isActive("blockquote"), run: () => runAsEdit(() => { editor.chain().focus().toggleBlockquote().run(); }), icon: Quote },
  ];

  return (
    <div className="cv-markdown-editor" data-readonly={disabled ? "true" : "false"} style={{ "--cv-editor-min-height": `${minHeight}px` } as CSSProperties}>
      {!disabled ? <div className="cv-markdown-editor__toolbar" aria-label={`${ariaLabel} formatting`}>
        {toolbar.map(({ label, active, run, icon: Icon }) => (
          <button
            key={label}
            type="button"
            className="cv-markdown-editor__tool"
            data-active={active ? "true" : "false"}
            aria-label={label}
            aria-pressed={active}
            onClick={run}
          >
            <Icon size={14} aria-hidden="true" />
          </button>
        ))}
        <span className="cv-markdown-editor__separator" aria-hidden="true" />
        {!editor.isActive("table") ? (
          <button
            type="button"
            className="cv-markdown-editor__tool"
            aria-label="Insert table"
            onClick={() => runAsEdit(() => { editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); })}
          >
            <Table2 size={14} aria-hidden="true" />
          </button>
        ) : (
          <>
            <button type="button" className="cv-markdown-editor__tool" aria-label="Add table row" onClick={() => runAsEdit(() => { editor.chain().focus().addRowAfter().run(); })}><Rows3 size={14} aria-hidden="true" /></button>
            <button type="button" className="cv-markdown-editor__tool" aria-label="Add table column" onClick={() => runAsEdit(() => { editor.chain().focus().addColumnAfter().run(); })}><Columns3 size={14} aria-hidden="true" /></button>
            <button type="button" className="cv-markdown-editor__tool" aria-label="Delete table" onClick={() => runAsEdit(() => { editor.chain().focus().deleteTable().run(); })}><Trash2 size={14} aria-hidden="true" /></button>
          </>
        )}
        <span className="cv-markdown-editor__spacer" />
        <button
          type="button"
          className="cv-markdown-editor__tool"
          aria-label="Undo"
          disabled={!editor.can().chain().focus().undo().run()}
          onClick={() => runAsEdit(() => { editor.chain().focus().undo().run(); })}
        >
          <Undo2 size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="cv-markdown-editor__tool"
          aria-label="Redo"
          disabled={!editor.can().chain().focus().redo().run()}
          onClick={() => runAsEdit(() => { editor.chain().focus().redo().run(); })}
        >
          <Redo2 size={14} aria-hidden="true" />
        </button>
      </div> : null}
      <EditorContent editor={editor} />
    </div>
  );
}
