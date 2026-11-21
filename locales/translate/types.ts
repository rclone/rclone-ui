/** The file that a text lives in: app.po (the windows), core.po (the Go side) or rclone.json. */
export type Kind = 'app' | 'core' | 'rclone'

export interface Row {
    id: string
    kind: Kind
    text: string
    /** The English plural of a core.po message about a count. */
    plural?: string
    ctx?: string
    /** The notes from the code (`#.` lines), as the English catalog has them. */
    notes?: string[]
    /** The files that use the text (`#:` lines), as the English catalog has them. */
    refs?: string[]
    /** An rclone text's key in rclone.json. */
    key?: string[]
    /** The heading that the text is listed under on its page. */
    group: string
    /** The other pages that show the text. */
    also?: string[]
}

export interface Page {
    id: string
    title: string
    part: 'app' | 'rclone'
    /** A line under the title, such as what a storage backend is. */
    about?: string
    /** Indexes into Catalog.rows, in the order that the page lists them. */
    rows: number[]
}

export interface Language {
    tag: string
    name: string
    pluralForms: string
}

export interface Catalog {
    built: string
    /** The header of the English app.po, which a language's app.po copies. */
    appHeader: string[]
    /** Every text, in the order of its file: app.po, then core.po, then rclone.json. */
    rows: Row[]
    pages: Page[]
    languages: Language[]
    /** The texts that ship for each language: languages.json, in its order. */
    names: Record<string, string>
    featured: { text: string; translations: Record<string, string> }
}

/** A language's translations as the repository has them, by row id. */
export interface Shipped {
    pluralForms: string
    values: Record<string, string[]>
    terms?: string
}
