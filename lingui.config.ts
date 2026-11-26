import { defineConfig } from '@lingui/cli'
import { formatter } from '@lingui/format-po'
import languages from './locales/languages.json' with { type: 'json' }

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
    format: formatter({ lineNumbers: false }),
    orderBy: 'message',
})
