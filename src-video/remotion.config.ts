// Every script that loads this runs with src-video as its working directory (the root
// package.json delegates the video:* scripts with `-w src-video`), which is what the
// process.cwd() paths below rely on.
import path from 'node:path'
import { webpack } from '@remotion/bundler'
import { Config } from '@remotion/cli/config'
import { enableTailwind } from '@remotion/tailwind'

Config.setEntryPoint('./index.ts')

Config.overrideWebpackConfig((currentConfiguration) => {
    // The frontend owns the Tailwind config; the compositions render its real components, so
    // they need the same theme. Its globs are config-relative, so being loaded from here is fine.
    const config = enableTailwind(currentConfiguration, {
        configLocation: path.resolve(process.cwd(), '../src-frontend/tailwind.config.js'),
    })
    config.plugins = [
        ...(config.plugins ?? []),
        // The preview drawer pulls in the docx/xlsx/pptx viewer libs, whose
        // Vite-only `?url` wasm imports don't resolve under Remotion's webpack.
        new webpack.NormalModuleReplacementPlugin(
            /preview[/\\]PreviewDrawer/,
            path.resolve(process.cwd(), 'mocks/PreviewDrawer.tsx')
        ),
        // The Toolbar debounces its search through wall-clock setTimeout, which
        // races the frame gate — replace with a synchronous identity hook.
        new webpack.NormalModuleReplacementPlugin(
            /^use-debounce$/,
            path.resolve(process.cwd(), 'mocks/useDebounce.ts')
        ),
        // lib/hosts.ts probes daemons over plugin-http (disabled in renders);
        // the mock's getHostInfo answers from a fixture and can suspend for the
        // Add Host "Checking…" beat (src-video/mocks/hosts.ts).
        new webpack.NormalModuleReplacementPlugin(
            /lib[/\\]hosts(\.ts)?$/,
            // biome-ignore lint/suspicious/noExplicitAny: webpack resolve data is untyped here
            (resource: any) => {
                const replacement = path.resolve(process.cwd(), 'mocks/hosts.ts')
                resource.request = replacement
                resource.context = path.dirname(replacement)
                if (resource.createData) {
                    resource.createData.resource = replacement
                    resource.createData.context = path.dirname(replacement)
                }
            }
        ),
        // The real client retries failing transports for ~27s per call; the mock
        // answers every endpoint instantly from src-video/fixtures.ts. Function form:
        // the context must move too, or the mock's own relative imports resolve
        // against lib/rclone/.
        new webpack.NormalModuleReplacementPlugin(
            /lib[/\\]rclone[/\\]client(\.ts)?$/,
            // biome-ignore lint/suspicious/noExplicitAny: webpack resolve data is untyped here
            (resource: any) => {
                const replacement = path.resolve(process.cwd(), 'mocks/rcloneClient.ts')
                resource.request = replacement
                resource.context = path.dirname(replacement)
                if (resource.createData) {
                    resource.createData.resource = replacement
                    resource.createData.context = path.dirname(replacement)
                }
            }
        ),
    ]
    return config
})
