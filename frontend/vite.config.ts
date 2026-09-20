import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vitejs.dev/config/
export default defineConfig(async () => ({
    // The pure-function tests sit beside their modules (`npm run test:unit`); Playwright's own
    // files are under e2e/, which its `testDir` keeps apart.
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
    },

    plugins: [react()],

    // One tree under src/: `@/x` is `src/x` (tsconfig.json says the same to the type checker).
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },

    // Some viewer libs (e.g. @extend-ai/react-xlsx) ship code-splitting Web Workers,
    // which require ES-module worker output rather than the default iife.
    worker: { format: 'es' },

    optimizeDeps: {
        // These viewer libs create Web Workers via `new URL('./worker.js', import.meta.url)`.
        // Vite's dep pre-bundler doesn't emit those worker files, so in dev the worker URL
        // 404s ("file does not exist in the optimize deps directory"). Excluding them routes
        // the workers through Vite's normal worker pipeline. (Prod/Rollup handles them fine.)
        exclude: ['@extend-ai/react-docx', '@extend-ai/react-xlsx', '@extend-ai/react-pptx'],
        // Because the packages above are excluded, Vite never scans them to discover their
        // own dependencies — so their (often CJS) imports like `react-dom/server` aren't
        // pre-bundled and named imports fail ("Importing binding name ... is not found").
        // Force-optimize the deps they import by name so interop is applied.
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

    build: { chunkSizeWarningLimit: 5120 },

    esbuild: {
        supported: {
            'top-level-await': false, //browsers can handle top-level-await features
        },
    },

    // Development: the pages are served by rclone-cloud with `--dev-proxy
    // http://localhost:1420`; the server forwards everything but its API here. HMR bypasses the
    // proxy on its own port.
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        hmr: { protocol: 'ws', host: 'localhost', port: 1421 },
        watch: {
            ignored: ['**/target/**'],
        },
    },
}))
