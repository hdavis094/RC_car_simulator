import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/languages/definitions/cpp/register';
import 'monaco-editor/languages/definitions/ini/register';
import 'monaco-editor/features/register.all';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { useEditorStore } from './editor-state.ts';
import { useSessionStore } from '../shell/session.ts';

Object.assign(self, { MonacoEnvironment: { getWorker: () => new EditorWorker() } });

export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const documents = useEditorStore((state) => state.documents);
  const active = useEditorStore((state) => state.active);
  const location = useEditorStore((state) => state.location);
  const diagnostics = useSessionStore((state) => state.diagnostics);
  const models = useRef(new Map<string, monaco.editor.ITextModel>());
  const views = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());

  useEffect(() => {
    if (!host.current) return;
    const instance = monaco.editor.create(host.current, {
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      scrollBeyondLastLine: false,
      padding: { top: 16 },
      model: null,
      ariaLabel: 'Firmware editor',
    });
    editor.current = instance;
    const changes = instance.onDidChangeModelContent(() => {
      const model = instance.getModel();
      if (model) useEditorStore.getState().edit(model.uri.path.slice(1), model.getValue());
    });
    const cursor = instance.onDidChangeCursorPosition(({ position }) => {
      if (host.current) {
        host.current.dataset['line'] = String(position.lineNumber);
        host.current.dataset['column'] = String(position.column);
      }
    });
    const modelMap = models.current;
    const viewMap = views.current;
    return () => {
      changes.dispose();
      cursor.dispose();
      instance.dispose();
      editor.current = null;
      for (const model of modelMap.values()) model.dispose();
      modelMap.clear();
      viewMap.clear();
    };
  }, []);

  useEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    for (const doc of documents) {
      let model = models.current.get(doc.path);
      if (!model) {
        const language = /\.(cpp|cc|c|h|hpp|ino)$/i.test(doc.path)
          ? 'cpp'
          : doc.path.endsWith('.ini')
            ? 'ini'
            : 'plaintext';
        model = monaco.editor.createModel(
          doc.text,
          language,
          monaco.Uri.from({ scheme: 'car', path: `/${doc.path}` }),
        );
        models.current.set(doc.path, model);
      } else if (model.getValue() !== doc.text) model.setValue(doc.text);
    }
    const next = active ? (models.current.get(active) ?? null) : null;
    if (instance.getModel() !== next) {
      const previous = instance.getModel();
      if (previous) views.current.set(previous.uri.path.slice(1), instance.saveViewState());
      instance.setModel(next);
      const view = active ? views.current.get(active) : null;
      if (view) instance.restoreViewState(view);
    }
    for (const [path, model] of models.current) {
      if (!documents.some((doc) => doc.path === path)) {
        model.dispose();
        models.current.delete(path);
        views.current.delete(path);
      }
    }
  }, [documents, active]);

  useEffect(() => {
    for (const [path, model] of models.current) {
      monaco.editor.setModelMarkers(
        model,
        'compiler',
        diagnostics
          .filter((d) => d.file === path)
          .map((d) => ({
            startLineNumber: d.line,
            startColumn: d.column,
            endLineNumber: d.line,
            endColumn: d.column + 1,
            message: d.message,
            severity:
              d.severity === 'error'
                ? monaco.MarkerSeverity.Error
                : d.severity === 'warning'
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
          })),
      );
    }
  }, [diagnostics, active, documents.length]);

  useEffect(() => {
    if (location?.path !== active || !location) return;
    editor.current?.setPosition({ lineNumber: location.line, column: location.column });
    editor.current?.revealLineInCenter(location.line);
    editor.current?.focus();
  }, [location, active]);
  return <div className="editor-host" ref={host} data-testid="firmware-editor" />;
}
