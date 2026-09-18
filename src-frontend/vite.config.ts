import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'


// https://vitejs.dev/config/
export default defineConfig(async () => ({
    // plugins: [
    //     react({
    //         babel: {
    //             plugins: [
    //                 [
    //                     'babel-plugin-react-compiler',
    //                     {
    //                         target: '18',
    //                         panicThreshold: 'all_errors',
    //                         logger: {
    //                             logEvent(filename, event) {
    //                                 console.log(`[Compiler] ${event.kind}: ${filename}`)
    //                             },
    //                         },
    //                     },
    //                 ],
    //             ],
    //         },
    //     }),
    // ],
    plugins: [react()],

    // Some viewer libs (e.g. @extend-ai/react-xlsx) ship code-splitting Web Workers,
    // which require ES-module worker output rather than the default iife.
    worker: { format: 'es' },

    optimizeDeps: {
        // These viewer libs create Web Workers via `new URL('./worker.js', import.meta.url)`.
        // Vite's dep pre-bundler doesn't emit those worker files, so in dev the worker URL
        // 404s ("file does not exist in the optimize deps directory"). Excluding them routes
        // the workers through Vite's normal worker pipeline. (Prod/Rollup handles them fine.)
        exclude: [
            '@extend-ai/react-docx',
            '@extend-ai/react-xlsx',
            '@extend-ai/react-pptx',
        ],
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

    // Development: the pages are always served by rclone-ui-server (standalone or embedded in
    // the desktop app) with `--dev-proxy http://localhost:1420`; the server forwards everything
    // but its API here. HMR bypasses the proxy on its own port.
    clearScreen: false,
    server: {
        port: 1420,
        strictPort: true,
        hmr: { protocol: 'ws', host: 'localhost', port: 1421 },
        watch: {
            ignored: ['**/src-tauri/**', '**/src-server/**', '**/src-shared/**', '**/target/**'],
        },
    },
}))
