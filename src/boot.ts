// The window's entry. It loads the window's language first, and the app after it, so every line of
// the app runs with the language in place (lib/i18n.ts).

import { activateLanguage, startLanguage } from '../lib/i18n'
import { systemLanguage } from '../lib/shell'

await activateLanguage(startLanguage(systemLanguage()))
await import('./main')
