import { useEffect, useState } from 'react'
import { Centered, Editor } from './Editor.tsx'
import { Start } from './Start.tsx'
import { fetchData, useRoute } from './store.ts'
import type { Catalog } from './types.ts'
import { buttons, validTag } from './ui.tsx'

export function App() {
    const [catalog, setCatalog] = useState<Catalog | null>(null)
    const [failed, setFailed] = useState(false)
    const route = useRoute()
    useEffect(() => {
        fetchData<Catalog>('catalog').then(setCatalog, () => setFailed(true))
    }, [])

    if (failed)
        return (
            <Centered>
                The texts could not be loaded. Check your connection and reload the page.
            </Centered>
        )
    if (!catalog) return <Centered>Loading the texts…</Centered>
    if (!route.tag) return <Start catalog={catalog} />
    if (route.tag === 'en')
        return <Centered>English is the language that the others are translated from.</Centered>
    if (validTag(route.tag) !== route.tag) {
        return (
            <Centered>
                <p>&ldquo;{route.tag}&rdquo; isn&rsquo;t a language code.</p>
                <a href="#/" className={`${buttons.secondary} mt-4`}>
                    Pick a language
                </a>
            </Centered>
        )
    }
    return <Editor key={route.tag} catalog={catalog} tag={route.tag} pageId={route.page} />
}
