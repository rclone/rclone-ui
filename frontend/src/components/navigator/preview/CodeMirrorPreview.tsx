import { type LanguageName, loadLanguage } from '@uiw/codemirror-extensions-langs'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { useMemo } from 'react'
import { getFileExtension } from '../utils'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewText from './usePreviewText'

// A handful of extensions the langs pack doesn't key directly — alias each to the
// closest available mode. Anything still unmatched renders as plain text (line
// numbers, no highlighting), which is the right fallback for .txt/.log/.csv/etc.
const LANGUAGE_ALIASES: Record<string, string> = {
    zsh: 'sh',
    hrl: 'erl',
    conf: 'ini',
    config: 'ini',
    env: 'properties',
    sol: 'solidity',
}

// Hardcoded dark-on-white content color. The built-in `light` theme leaves the content
// color unset, so it inherits the app's dark-mode (near-white) foreground and the text
// is invisible on the white editor. Applied via `extensions` (which win over the `theme`
// prop) so it overrides that. Syntax-highlighted tokens keep their own darker colors.
const LIGHT_CONTENT_THEME = EditorView.theme(
    {
        '&': { backgroundColor: '#ffffff', color: '#111827' },
        '.cm-content': { color: '#111827', caretColor: '#111827' },
        '.cm-gutters': { backgroundColor: '#f9fafb', color: '#9ca3af', border: 'none' },
    },
    { dark: false }
)

// Read-only viewer, hardcoded light (like the other preview viewers). basicSetup is
// trimmed for a static view — syntax highlighting + line numbers, no active-line chrome.
export default function CodeMirrorPreview({
    url,
    name,
    authHeader,
    onDownload,
}: PreviewViewerProps) {
    const { text, error, progress } = usePreviewText(url, authHeader)

    const extensions = useMemo(() => {
        const ext = getFileExtension(name)
        const lang = loadLanguage((LANGUAGE_ALIASES[ext] ?? ext) as LanguageName)
        // Wrap long lines (no horizontal scroll) — nicer for logs/csv/prose.
        const base = [EditorView.lineWrapping, LIGHT_CONTENT_THEME]
        return lang ? [...base, lang] : base
    }, [name])

    if (error) {
        return <PreviewError message={error} onDownload={onDownload} />
    }

    if (text === null) {
        return <PreviewLoading progress={progress} />
    }

    return (
        <CodeMirror
            value={text}
            readOnly={true}
            theme="light"
            extensions={extensions}
            height="100%"
            className="w-full h-full text-sm"
            basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
                // In-file search: Cmd/Ctrl+F opens the search panel, highlight matches.
                searchKeymap: true,
                highlightSelectionMatches: true,
            }}
        />
    )
}
