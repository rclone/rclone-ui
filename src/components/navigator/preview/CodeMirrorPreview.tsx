import { Button } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import CodeMirror, { EditorState, EditorView, type Extension } from '@uiw/react-codemirror'
import { DownloadBracket as DownloadBracketIcon } from '@zappicon/react'
import { useEffect, useMemo, useState } from 'react'
import { formatBytes } from '../../../../lib/format'
import { hasLanguage, loadLanguage } from './languages'
import { PreviewError, PreviewLoading, type PreviewViewerProps } from './previewStates'
import usePreviewText from './usePreviewText'

/** How much of a text file the viewer loads. Loading only the start keeps a large log responsive. */
const TEXT_HEAD = 10 * 1024 * 1024

// A fixed dark text color on white. The built-in `light` theme leaves the content color unset,
// so in dark mode the text inherits the app's near-white color and is invisible on the white
// editor. It is applied through `extensions`, which take priority over the `theme` prop.
// Highlighted tokens keep their own darker colors.
const LIGHT_CONTENT_THEME = EditorView.theme(
    {
        '&': { backgroundColor: '#ffffff', color: '#111827' },
        '.cm-content': { color: '#111827', caretColor: '#111827' },
        '.cm-gutters': { backgroundColor: '#f9fafb', color: '#9ca3af', border: 'none' },
    },
    { dark: false }
)

/**
 * CodeMirror's own words (its search panel, Go to line, and the folding of code) in the app's
 * language. The viewer is read-only, so the words of its replace fields never show.
 */
function editorPhrases(): Extension {
    // Every message writes its context out in full rather than sharing a constant, because the
    // extraction reads only literal text.
    return EditorState.phrases.of({
        Find: t({
            message: 'Find',
            context: 'search panel of the text viewer',
            comment: 'The field for the text to find.',
        }),
        next: t({
            message: 'next',
            context: 'search panel of the text viewer',
            comment: 'Button: goes to the next match.',
        }),
        previous: t({
            message: 'previous',
            context: 'search panel of the text viewer',
            comment: 'Button: goes to the previous match.',
        }),
        all: t({
            message: 'all',
            context: 'search panel of the text viewer',
            comment: 'Button: selects every match.',
        }),
        'match case': t({
            message: 'match case',
            context: 'search panel of the text viewer',
            comment: 'Checkbox.',
        }),
        regexp: t({
            message: 'regexp',
            context: 'search panel of the text viewer',
            comment: 'Checkbox: search with a regular expression.',
        }),
        'by word': t({
            message: 'by word',
            context: 'search panel of the text viewer',
            comment: 'Checkbox: match whole words only.',
        }),
        close: t({
            message: 'close',
            context: 'search panel of the text viewer',
            comment: 'Button: closes the search panel.',
        }),
        'current match': t({
            message: 'current match',
            context: 'search panel of the text viewer',
            comment: 'Read by screen readers.',
        }),
        'on line': t({
            message: 'on line',
            context: 'search panel of the text viewer',
            comment: 'Read by screen readers after a match: "on line 12".',
        }),
        'Go to line': t({ message: 'Go to line', context: 'search panel of the text viewer' }),
        go: t({
            message: 'go',
            context: 'search panel of the text viewer',
            comment: 'Button: goes to the line that was typed.',
        }),
        'Fold line': t({
            message: 'Fold line',
            context: 'search panel of the text viewer',
            comment: 'Hides the lines of a block of code.',
        }),
        'Unfold line': t({
            message: 'Unfold line',
            context: 'search panel of the text viewer',
            comment: 'Shows the hidden lines of a block of code.',
        }),
        'Folded lines': t({
            message: 'Folded lines',
            context: 'search panel of the text viewer',
            comment: 'Read by screen readers.',
        }),
        'Unfolded lines': t({
            message: 'Unfolded lines',
            context: 'search panel of the text viewer',
            comment: 'Read by screen readers.',
        }),
        'folded code': t({
            message: 'folded code',
            context: 'search panel of the text viewer',
            comment: 'The mark that stands for hidden lines.',
        }),
        unfold: t({
            message: 'unfold',
            context: 'search panel of the text viewer',
            comment: 'Shows the hidden lines.',
        }),
        'Control character': t({
            message: 'Control character',
            context: 'search panel of the text viewer',
            comment: 'An invisible character in the text, such as a tab or a null byte.',
        }),
    })
}

// A read-only viewer that is always light, like the other preview viewers. basicSetup is trimmed
// for a static view: syntax highlighting and line numbers, without active-line highlighting.
export default function CodeMirrorPreview({ url, name, onDownload }: PreviewViewerProps) {
    const { text, error, progress, truncated } = usePreviewText(url, { maxBytes: TEXT_HEAD })

    // The file's language loads alongside its text (`languages.ts`), and the viewer waits for
    // both, so the text doesn't appear without colors first. Plain text has nothing to wait for.
    const [language, setLanguage] = useState<{ name: string; extension: Extension | null }>()
    useEffect(() => {
        if (!hasLanguage(name)) return
        let live = true
        loadLanguage(name).then((extension) => {
            if (live) setLanguage({ name, extension })
        })
        return () => {
            live = false
        }
    }, [name])
    const languageReady = !hasLanguage(name) || language?.name === name
    const lang = language?.name === name ? language.extension : null

    const extensions = useMemo(() => {
        // Wrap long lines instead of scrolling horizontally, which reads better for logs, CSV and
        // prose.
        const base = [EditorView.lineWrapping, LIGHT_CONTENT_THEME, editorPhrases()]
        return lang ? [...base, lang] : base
    }, [lang])

    if (error) {
        return <PreviewError message={error} onDownload={onDownload} />
    }

    if (text === null || !languageReady) {
        return <PreviewLoading progress={progress} />
    }

    const head = formatBytes(TEXT_HEAD)
    const viewer = (
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
                // Search in the file. Cmd/Ctrl+F opens the search panel, and matches are
                // highlighted.
                searchKeymap: true,
                highlightSelectionMatches: true,
            }}
        />
    )
    if (!truncated) return viewer

    return (
        <div className="flex flex-col w-full h-full">
            <div className="flex items-center justify-between gap-2 px-3 py-2 text-sm border-b shrink-0 border-divider bg-default-50 text-default-600">
                <span>
                    <Trans>Showing the first {head}. Download the file to see all of it.</Trans>
                </span>
                <Button
                    size="sm"
                    variant="flat"
                    onPress={onDownload}
                    startContent={<DownloadBracketIcon className="size-4" />}
                    data-focus-visible="false"
                >
                    {t({ message: 'Download', comment: 'Button: downloads the file.' })}
                </Button>
            </div>
            <div className="flex-1 min-h-0">{viewer}</div>
        </div>
    )
}
