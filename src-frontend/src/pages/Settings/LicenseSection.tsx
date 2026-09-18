import { Button, Divider, Input, Tooltip, cn } from '@heroui/react'

import { CheckIcon, InfoIcon } from 'lucide-react'
import {
    type DetailedHTMLProps,
    type HTMLAttributes,
    startTransition,
    useEffect,
    useState,
} from 'react'
import { revokeMachineLicense, validateLicense } from '../../../lib/license'
import { usePersistedStore } from '../../../store/persisted'
import BaseSection from './BaseSection'
import { ask, message } from '../../../lib/api/dialog'

declare global {
    // biome-ignore lint/style/noNamespace: <you pass the butter>
    namespace JSX {
        interface IntrinsicElements {
            'stripe-pricing-table': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>
        }
    }
}

export default function LicenseSection() {
    const [isLicenseEditable, setIsLicenseEditable] = useState(false)
    const licenseKey = usePersistedStore((state) => state.licenseKey)
    const licenseValid = usePersistedStore((state) => state.licenseValid)

    const [isRevoking, setIsRevoking] = useState(false)
    const [isActivating, setIsActivating] = useState(false)
    const [licenseKeyInput, setLicenseKeyInput] = useState('')

    const [showPricingTable, setShowPricingTable] = useState(false)

    useEffect(() => {
        startTransition(() => {
            setLicenseKeyInput(licenseKey || '')
            setIsLicenseEditable(!licenseKey)
        })
    }, [licenseKey])

    useEffect(() => {
        const script = document.createElement('script')
        script.src = 'https://js.stripe.com/v3/pricing-table.js'
        script.async = true
        document.body.appendChild(script)
        const cancelTimeout = setTimeout(() => {
            setShowPricingTable(true)
        }, 1000)
        return () => {
            clearTimeout(cancelTimeout)
            setShowPricingTable(false)
            document.body.removeChild(script)
        }
    }, [])

    return (
        <BaseSection
            header={{
                title: 'License',
                endContent: licenseValid ? (
                    <p className="text-large">❤️‍🔥</p>
                ) : (
                    <Tooltip
                        className="max-w-[200px]"
                        content="Why? To unlock extra features not available in rclone, and turbo-charge development ♥️"
                    >
                        <Button
                            isIconOnly={true}
                            variant="light"
                            color="primary"
                            data-focus-visible="false"
                        >
                            <InfoIcon className="w-5 h-5" />
                        </Button>
                    </Tooltip>
                ),
            }}
        >
            <div className="flex flex-row justify-center w-full gap-2 px-8 -mt-2">
                <Input
                    placeholder="Enter license key"
                    value={licenseKeyInput}
                    onChange={(e) => setLicenseKeyInput(e.target.value)}
                    size="lg"
                    isDisabled={!isLicenseEditable || isActivating}
                    autoCapitalize="none"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck="false"
                    endContent={licenseValid && <CheckIcon className="w-5 h-5 text-success" />}
                    data-focus-visible="false"
                    fullWidth={true}
                />

                {!licenseValid && (
                    <Button
                        isLoading={isActivating}
                        size="lg"
                        onPress={async () => {
                            if (!licenseKeyInput) {
                                await message('Please enter a license key', {
                                    title: 'Error',
                                    kind: 'error',
                                })
                                return
                            }
                            setIsActivating(true)
                            try {
                                await validateLicense(licenseKeyInput)
                            } catch (e) {
                                await message(
                                    e instanceof Error
                                        ? e.message
                                        : 'An error occurred. Please try again.',
                                    {
                                        title: 'Error',
                                        kind: 'error',
                                        okLabel: 'Ok',
                                    }
                                )
                                return
                            } finally {
                                setIsActivating(false)
                            }

                            await message('Your license has been successfully activated.', {
                                title: 'Congrats!',
                                kind: 'info',
                            })
                        }}
                        data-focus-visible="false"
                    >
                        Activate
                    </Button>
                )}
                {licenseValid && (
                    <Button
                        isLoading={isRevoking}
                        color="danger"
                        variant="ghost"
                        size="lg"
                        onPress={async () => {
                            // usePersistedStore.setState({
                            //     licenseKey: undefined,
                            //     licenseValid: false,
                            // })
                            // return

                            const answer = await ask(
                                'Are you sure you want to deactivate your license? You can always activate it again later.',
                                {
                                    title: 'Deactivate License',
                                    kind: 'warning',
                                }
                            )

                            if (!answer) {
                                return
                            }

                            setIsRevoking(true)
                            try {
                                await revokeMachineLicense(licenseKeyInput)
                            } catch (e) {
                                await message(
                                    e instanceof Error
                                        ? e.message
                                        : 'An error occurred. Please try again.',
                                    {
                                        title: 'Error',
                                        kind: 'error',
                                        okLabel: 'Ok',
                                    }
                                )
                                return
                            } finally {
                                setIsRevoking(false)
                            }

                            await message('Your license has been successfully deactivated.', {
                                title: 'License deactivated',
                                kind: 'info',
                            })
                        }}
                        data-focus-visible="false"
                    >
                        Deactivate
                    </Button>
                )}
            </div>

            <Divider />

            <div
                className={cn(
                    'w-full overflow-hidden border-0 border-red-500 left-28 h-[485px] opacity-0 transition-opacity duration-300 ease-in-out',
                    showPricingTable && 'opacity-100'
                )}
            >
                <div className="block dark:hidden">
                    <stripe-pricing-table
                        pricing-table-id="prctbl_1SYNElE0hPdsH0naNChn9pSc"
                        publishable-key="pk_live_51QmUqyE0hPdsH0naBICHzb0j5O5eTKyYnY72nOaS6aT99y3EBeCOyeihI2xX05D6cczifqPsX6vHhor8ozSblXPl00LqNwMxBE"
                    />
                </div>

                <div className="hidden dark:block">
                    <stripe-pricing-table
                        pricing-table-id="prctbl_1SYNCxE0hPdsH0naksdGupEy"
                        publishable-key="pk_live_51QmUqyE0hPdsH0naBICHzb0j5O5eTKyYnY72nOaS6aT99y3EBeCOyeihI2xX05D6cczifqPsX6vHhor8ozSblXPl00LqNwMxBE"
                    />
                </div>
            </div>
        </BaseSection>
    )
}
