// biome-ignore-all lint/correctness/noNodejsModules: the config runs in Node
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { buildData } from './catalog.ts'

/**
 * The translation site (locales/README.md): a static site that lists the app's texts for
 * translators, and hands them a file to send back.
 *
 *   npm run translate          # the site on a dev server, with the texts as they are now
 *   npm run translate:build    # the site in locales/translate/dist, as GitHub Pages serves it
 */
const DATA = /^\/data\/([\w-]+)\.json$/
const repo = fileURLToPath(new URL('../..', import.meta.url))

/** Serves the texts from locales/ as data/<name>.json, and writes them into the build. */
function texts(): Plugin {
    return {
        name: 'translate-texts',
        configureServer(server) {
            server.watcher.add(`${repo}/locales`)
            server.middlewares.use((req, res, next) => {
                const name = DATA.exec(req.url?.split('?')[0] ?? '')?.[1]
                const data = name ? buildData(repo).get(name) : undefined
                if (!data) return next()
                res.setHeader('Content-Type', 'application/json')
                res.end(data)
            })
        },
        generateBundle() {
            for (const [name, data] of buildData(repo)) {
                this.emitFile({ type: 'asset', fileName: `data/${name}.json`, source: data })
            }
        },
    }
}

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: './',
    plugins: [react(), tailwindcss(), texts()],
    build: { outDir: 'dist', emptyOutDir: true, reportCompressedSize: false },
    server: { host: '127.0.0.1', port: 9246 },
})
