import { i18n } from '@lingui/core'

// The tests read the English text that is in the code. No catalog is loaded: a message that the
// language doesn't have shows as it is written.
i18n.loadAndActivate({ locale: 'en', messages: {} })
