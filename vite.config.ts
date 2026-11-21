/// <reference types="vitest/config" />
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { lingui } from '@lingui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The chunk size that triggers a warning, in kB as Vite counts them. It is above the app's own
 * chunks (the largest, the entry, is ~660 kB), so a chunk that grows past it gets noticed.
 */
const CHUNK_WARNING_KB = 1024

/**
 * Chunks known to be larger than CHUNK_WARNING_KB. They load only when a matching file is
 * previewed:
 * - the presentation viewer's map atlas (region-map-atlas, ~1.5 MB, for slides with a map chart);
 * - the Office fonts that the document viewers draw text with (carlito-data, intos-narrow-data
 *   and others, ~0.6 to 1.2 MB each);
 * - the spreadsheet viewer's drawing engine (payload, ~1.7 MB).
 * Vite's own warning limit is set above them (`chunkSizeWarningLimit`).
 */
const KNOWN_LARGE_CHUNKS = /^(?:region-map-atlas|[a-z-]+-data|payload)\b/

/** Warns, as Vite would, about any chunk over CHUNK_WARNING_KB that isn't a known large one. */
function chunkSizeWarning(): Plugin {
    return {
        name: 'chunk-size-warning',
        apply: 'build',
        // Measure the chunks as they are written, which is what Vite's own report measures.
        writeBundle(_, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type !== 'chunk' || KNOWN_LARGE_CHUNKS.test(chunk.name)) continue
                const kB = Buffer.byteLength(chunk.code) / 1000
                if (kB > CHUNK_WARNING_KB) {
                    this.warn(
                        `${chunk.fileName} is ${Math.round(kB)} kB, over ${CHUNK_WARNING_KB} kB`
                    )
                }
            }
        },
    }
}

const OFFICE_VIEWERS = 'node_modules/@extend-ai'
/** Matches the name of a font file in a viewer's dist folder, or an import of one. */
const OFFICE_FONT_FILE = /^(?:\.\/)?([a-z-]+)-data-[A-Z0-9]+\.js$/

/**
 * Builds each Office font once. The docx, pptx and xlsx viewers each bundle their own copies of
 * the same fonts (carlito-data-*.js and others, from @extend-ai/office-fonts), so without this
 * every font is built three times, about 11 MB more. A copy only exports the font's `faces`. When
 * `faces` is the same in every copy, all imports of the font are sent to one copy. A font whose
 * copies differ is left alone, with a warning.
 */
function dedupeOfficeFonts(): Plugin {
    const canonical = new Map<string, string>()
    return {
        name: 'dedupe-office-fonts',
        enforce: 'pre',
        configResolved(config) {
            const copies = new Map<string, { path: string; faces: string }[]>()
            for (const viewer of readdirSync(OFFICE_VIEWERS, { withFileTypes: true })) {
                const dist = join(OFFICE_VIEWERS, viewer.name, 'dist')
                if (!(viewer.isDirectory() && existsSync(dist))) continue
                for (const file of readdirSync(dist)) {
                    const font = OFFICE_FONT_FILE.exec(file)?.[1]
                    if (!font) continue
                    const text = readFileSync(join(dist, file), 'utf8')
                    const faces = text.split('\n').find((line) => line.startsWith('var faces = '))
                    if (!faces) continue
                    const list = copies.get(font) ?? []
                    list.push({ path: resolve(dist, file), faces })
                    copies.set(font, list)
                }
            }
            for (const [font, list] of copies) {
                if (list.some((copy) => copy.faces !== list[0].faces)) {
                    config.logger.warn(`The copies of the ${font} font differ, so each is built.`)
                    continue
                }
                canonical.set(font, list.map((copy) => copy.path).sort()[0])
            }
        },
        resolveId(source, importer) {
            if (!importer?.includes('/@extend-ai/')) return null
            const font = OFFICE_FONT_FILE.exec(source)?.[1]
            return (font && canonical.get(font)) || null
        },
    }
}

export default defineConfig({
    plugins: [
        react(),
        // The windows' translations (lingui.config.ts): it compiles a catalog (.po) when a window
        // imports it, and turns the macros in the code (t, Trans, plural) into lookups.
        lingui({ macroTransform: true }),
        tailwindcss(),
        dedupeOfficeFonts(),
        chunkSizeWarning(),
    ],

    // Some viewer libs (e.g. @extend-ai/react-xlsx) ship code-splitting Web Workers,
    // which require ES-module worker output rather than the default iife.
    worker: { format: 'es' },

    optimizeDeps: {
        // These viewer libs create Web Workers via `new URL('./worker.js', import.meta.url)`.
        // Vite's dep pre-bundler doesn't emit those worker files, so in dev the worker URL
        // 404s ("file does not exist in the optimize deps directory"). Excluding them sends
        // the workers through Vite's normal worker pipeline. Production builds with Rollup
        // handle them fine.
        exclude: ['@extend-ai/react-docx', '@extend-ai/react-xlsx', '@extend-ai/react-pptx'],
        // Because the packages above are excluded, Vite never scans them for their own
        // dependencies. Their imports, which are often CJS (such as `react-dom/server`), aren't
        // pre-bundled, so named imports fail ("Importing binding name ... is not found").
        // Force-optimizing the dependencies they import by name makes Vite apply the interop.
        include: [
            'react-dom/server',
            'regl',
            'topojson-client',
            'utif',
            'fast-png',
            '@chenglou/pretext',
            'fflate',
            'd3-geo',
            'd3-hierarchy',
            'd3-scale',
            'd3-shape',
            '@tanstack/react-virtual',
            '@tanstack/virtual-core',
        ],
    },

    test: {
        // Makes English the language before any test runs (lib/i18n.ts).
        setupFiles: ['./src/testSetup.ts'],
    },

    build: {
        // In kB. This is above the known large chunks (KNOWN_LARGE_CHUNKS). Every other chunk is
        // held to CHUNK_WARNING_KB by `chunkSizeWarning`.
        chunkSizeWarningLimit: 2560,
        // The gzip column costs about a second per build, and it doesn't match what ships,
        // because the pages are embedded with zstd compression (tools/zstdassets).
        reportCompressedSize: false,
    },

    // The dev server that the app proxies to when FRONTEND_DEVSERVER_URL is set (app/assets), and
    // that the core's media server allows as an origin. The port is fixed, so the server fails
    // rather than moving to another port. Wails' proxy dials localhost over IPv4 only, while
    // Vite's "localhost" can be IPv6 only (::1) on macOS, so it listens on 127.0.0.1.
    server: {
        host: '127.0.0.1',
        port: 9245,
        strictPort: true,
    },
})
