import { activateLanguage, startLanguage } from '../lib/i18n'
import { systemLanguage } from '../lib/shell'

await activateLanguage(startLanguage(systemLanguage()))
await import('./main')
