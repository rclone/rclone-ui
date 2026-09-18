import { usePersistedStore } from '../store/persisted'
import { licenseRevoke, licenseValidate } from './api/app'

// The license API is called by the server (it owns the machine id and persists the outcome);
// the page mirrors the result into its store so the UI updates without a round trip.

export async function validateLicense(licenseKey: string) {
    console.log('[validateLicense]')
    await licenseValidate(licenseKey)
    usePersistedStore.setState({ licenseKey, licenseValid: true })
    console.log('[validateLicense] license validated')
}

export async function revokeMachineLicense(licenseKey: string) {
    console.log('[revokeMachineLicense]')
    await licenseRevoke(licenseKey)
    usePersistedStore.setState({ licenseKey: undefined, licenseValid: false })
    console.log('[revokeMachineLicense] license revoked')
}
