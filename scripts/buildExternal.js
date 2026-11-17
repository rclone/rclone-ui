import { execSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { readdir, rename, unlink } from 'fs/promises'

console.log('[buildExternal] building with node', process.version)

async function findJsFiles(dir) {
    const entries = await readdir(dir, { recursive: true })
    return entries.filter((entry) => entry.endsWith('.js')).map((entry) => join(dir, entry))
}

// Get the project root directory
const __dirname = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = join(__dirname, '..')

async function buildExternal() {
    try {
        // Compile TypeScript using local tsc
        console.log('[buildExternal] Compiling TypeScript...')
        execSync(
            // skipLibCheck mirrors tsconfig.json: a bare-CLI tsc ignores tsconfig and
            // auto-includes every node_modules/@types package, and Remotion's transitive
            // @types/dom-webcodecs collides with the WebCodecs types TS now bundles in lib.dom.
            'npx tsc main.ts --target es2020 --module esnext --moduleResolution bundler --skipLibCheck --listEmittedFiles',
            {
                stdio: 'inherit',
                cwd: projectRoot,
            }
        )

        // Bundle with esbuild
        console.log('[buildExternal] Bundling with esbuild...')
        execSync(
            'npx esbuild main.js --bundle --format=esm --target=esnext --outfile=out.js --minify --legal-comments=none',
            {
                stdio: 'inherit',
                cwd: projectRoot,
            }
        )

        // Move output file to public directory - cross platform
        console.log('[buildExternal] Moving output file to public directory...')
        await rename(join(projectRoot, 'out.js'), join(projectRoot, 'public', 'out.js'))

        // Clean up temporary files - cross platform
        console.log('[buildExternal] Cleaning up...')
        await Promise.all([
            // Remove lib/*.js files - preserve .ts files
            (async () => {
                const jsFiles = await findJsFiles(join(projectRoot, 'lib'))
                await Promise.all(jsFiles.map((file) => unlink(file).catch(() => {})))
            })(),
            // Remove store/*.js files - preserve .ts files
            (async () => {
                const jsFiles = await findJsFiles(join(projectRoot, 'store'))
                await Promise.all(jsFiles.map((file) => unlink(file).catch(() => {})))
            })(),
            // Remove main.js
            unlink(join(projectRoot, 'main.js')).catch(() => {}), // Ignore if file doesn't exist
        ])

        console.log('[buildExternal] Build completed successfully!')
    } catch (error) {
        console.error('[buildExternal] Build failed:', error)
        process.exit(1)
    }
}

buildExternal()
