import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const host = process.env.TAURI_DEV_HOST

// https://vitejs.dev/config/ & https://tauri.app/start/frontend/vite/
export default defineConfig({
    plugins: [react()],

    // Some viewer libs (e.g. @extend-ai/react-xlsx) ship code-splitting Web Workers,
    // which require ES-module worker output rather than the default iife.
    worker: { format: 'es' },

    // Vite 8 switched to Rolldown for depOpts. Should check whether this is still required.
    // (Probably is)
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

    build: {
        chunkSizeWarningLimit: 5120,
        // Tauri uses Chromium on Windows and WebKit on macOS and Linux
        target:
          process.env.TAURI_ENV_PLATFORM == 'windows'
            ? 'chrome105'
            : 'safari13',
        // don't minify for debug builds
        minify: !process.env.TAURI_ENV_DEBUG,
        // produce sourcemaps for debug builds
        sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },

    // prevent vite from obscuring rust errors
    clearScreen: false,
    server: {
        // make sure this port matches the devUrl port in tauri.conf.json file
        port: 1420,
        // Tauri expects a fixed port, fail if that port is not available
        strictPort: true,
        // if the host Tauri is expecting is set, use it
        host: host || false,
        hmr: host
          ? {
              protocol: 'ws',
              host,
              port: 1421,
          }
          : undefined,

        watch: {
            // tell vite to ignore watching `src-tauri`
            ignored: ['**/src-tauri/**'],
        },
    },
})
