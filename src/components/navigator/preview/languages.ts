// Syntax highlighting for the text viewer (`CodeMirrorPreview`). Each language is its own chunk,
// loaded when a file of that kind is opened. The langs pack (`@uiw/codemirror-extensions-langs`)
// isn't used, because it imports every grammar up front: 1.6 MB for every file.
//
// The tables cover the extensions that the viewer receives (FileIcon's code, config and text
// types) and that have a grammar, and a few files known by their name, which come first. Any
// other extension (.txt, .log, .csv, .bat…) is shown as plain text, with line numbers but no
// colors.

import { StreamLanguage, type StreamParser } from '@codemirror/language'
import type { Extension } from '@uiw/react-codemirror'
import { getFileExtension } from '../utils'

type Load = () => Promise<Extension>

/** Wraps a CodeMirror 5 mode (`@codemirror/legacy-modes`) as a language. */
function legacy(load: () => Promise<StreamParser<unknown>>): Load {
    return async () => StreamLanguage.define(await load())
}

const javascript =
    (config: { jsx?: boolean; typescript?: boolean }): Load =>
    () =>
        import('@codemirror/lang-javascript').then((m) => m.javascript(config))
const cpp: Load = () => import('@codemirror/lang-cpp').then((m) => m.cpp())
const html: Load = () => import('@codemirror/lang-html').then((m) => m.html())
const markdown: Load = () => import('@codemirror/lang-markdown').then((m) => m.markdown())
const yaml: Load = () => import('@codemirror/lang-yaml').then((m) => m.yaml())
const shell = legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell))
const perl = legacy(() => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl))
const erlang = legacy(() => import('@codemirror/legacy-modes/mode/erlang').then((m) => m.erlang))
const clojure = legacy(() => import('@codemirror/legacy-modes/mode/clojure').then((m) => m.clojure))
const groovy = legacy(() => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy))
const diff = legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff))
// INI, .conf, .env and Java properties files, which have `key = value` lines, `[sections]` and
// comments.
const properties = legacy(() =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)
)

/** Keyed by lowercase extension. */
const LANGUAGES = new Map<string, Load>(
    Object.entries({
        js: javascript({}),
        jsx: javascript({ jsx: true }),
        ts: javascript({ typescript: true }),
        tsx: javascript({ jsx: true, typescript: true }),
        json: () => import('@codemirror/lang-json').then((m) => m.json()),
        py: () => import('@codemirror/lang-python').then((m) => m.python()),
        java: () => import('@codemirror/lang-java').then((m) => m.java()),
        c: cpp,
        cpp,
        h: cpp,
        hpp: cpp,
        go: () => import('@codemirror/lang-go').then((m) => m.go()),
        rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
        php: () => import('@codemirror/lang-php').then((m) => m.php()),
        html,
        htm: html,
        xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
        css: () => import('@codemirror/lang-css').then((m) => m.css()),
        scss: () => import('@codemirror/lang-sass').then((m) => m.sass()),
        sass: () => import('@codemirror/lang-sass').then((m) => m.sass({ indented: true })),
        less: () => import('@codemirror/lang-less').then((m) => m.less()),
        sql: () => import('@codemirror/lang-sql').then((m) => m.sql({ dialect: m.StandardSQL })),
        vue: () => import('@codemirror/lang-vue').then((m) => m.vue()),
        svelte: () => import('@replit/codemirror-lang-svelte').then((m) => m.svelte()),
        md: markdown,
        markdown,
        yaml,
        yml: yaml,
        rb: legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
        cs: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
        kt: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
        scala: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
        dart: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart)),
        swift: legacy(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
        sh: shell,
        bash: shell,
        zsh: shell,
        ps1: legacy(() =>
            import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)
        ),
        lua: legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
        r: legacy(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
        pl: perl,
        pm: perl,
        erl: erlang,
        hrl: erlang,
        clj: clojure,
        cljs: clojure,
        hs: legacy(() => import('@codemirror/legacy-modes/mode/haskell').then((m) => m.haskell)),
        ml: legacy(() => import('@codemirror/legacy-modes/mode/mllike').then((m) => m.oCaml)),
        fs: legacy(() => import('@codemirror/legacy-modes/mode/mllike').then((m) => m.fSharp)),
        vb: legacy(() => import('@codemirror/legacy-modes/mode/vb').then((m) => m.vb)),
        s: legacy(() => import('@codemirror/legacy-modes/mode/gas').then((m) => m.gas)),
        gradle: groovy,
        groovy,
        proto: legacy(() =>
            import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf)
        ),
        diff,
        patch: diff,
        toml: legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
        ini: properties,
        cfg: properties,
        conf: properties,
        config: properties,
        env: properties,
        properties,
    })
)

/** Files known by their name, whatever their extension says. Checked before the extensions. */
const BY_NAME: [RegExp, Load][] = [
    [
        /^CMakeLists\.txt$/,
        legacy(() => import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake)),
    ],
    [
        /^extensions\.conf$/i,
        legacy(() => import('@codemirror/legacy-modes/mode/asterisk').then((m) => m.asterisk)),
    ],
    [
        /^nginx.*\.conf$/i,
        legacy(() => import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx)),
    ],
]

const SEPARATOR = /[\\/]/

function loaderFor(name: string): Load | undefined {
    const base = name.split(SEPARATOR).pop() ?? name
    return (
        BY_NAME.find(([pattern]) => pattern.test(base))?.[1] ??
        LANGUAGES.get(getFileExtension(name))
    )
}

export function hasLanguage(name: string): boolean {
    return loaderFor(name) !== undefined
}

/**
 * Loads the highlighting for a file named `name`. Returns `null` for plain text, and also when
 * the language's chunk can't be loaded (the text is still shown).
 */
export async function loadLanguage(name: string): Promise<Extension | null> {
    const load = loaderFor(name)
    if (!load) return null
    try {
        return await load()
    } catch {
        return null
    }
}
