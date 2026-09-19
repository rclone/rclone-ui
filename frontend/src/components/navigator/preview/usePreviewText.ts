import { useMemo } from 'react'
import usePreviewBytes from './usePreviewBytes'

// Reused across renders; UTF-8, non-fatal (invalid bytes become U+FFFD rather than throwing).
const decoder = new TextDecoder('utf-8')

/** Fetches a preview target's bytes and decodes them to a UTF-8 string for the code/text viewer. */
export default function usePreviewText(url: string) {
    const { buffer, isLoading, error, progress } = usePreviewBytes(url)
    const text = useMemo(() => (buffer ? decoder.decode(buffer) : null), [buffer])
    return { text, isLoading, error, progress }
}
