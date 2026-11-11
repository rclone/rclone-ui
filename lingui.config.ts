import { defineConfig } from '@lingui/cli'
import { formatter } from '@lingui/format-po'
import languages from './locales/languages.json' with { type: 'json' }

/**
 * The windows' text (locales/README.md). The English text in the code is each message's key, and
 * `npm run i18n` collects the messages into locales/<language>/app.po. Vite compiles a catalog
 * when a window imports it (lib/i18n.ts), so there is no compile step.
 *
 * `pseudo` is generated from English with accents and padding. It shows the text that was
 * never marked for translation, and the layouts that longer text breaks. Only a dev build
 * offers it.
 */
export default defineConfig({
    sourceLocale: 'en',
    locales: [...Object.keys(languages), 'pseudo'],
    pseudoLocale: { locale: 'pseudo', prepend: '[', append: ']', extend: 0.3 },
    fallbackLocales: { default: 'en' },
    catalogs: [
        {
            path: '<rootDir>/locales/{locale}/app',
            include: ['<rootDir>/src', '<rootDir>/lib'],
            exclude: ['**/bindings/**', '**/*.test.ts', '**/*.test.tsx'],
        },
    ],
    // No line numbers, so a catalog only changes when a message does.
    format: formatter({ lineNumbers: false }),
    orderBy: 'message',
})
