import { test as setup } from '@playwright/test'
import { signIn } from './helpers'

// Runs once before the suite: signs the owner into the default server and saves the cookie as
// the storage state every test's `page` and `request` start from.
setup('sign in to the default server', async ({ request }) => {
    await signIn(request)
    await request.storageState({ path: 'e2e/.tmp/storage.json' })
})
