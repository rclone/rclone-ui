import { Button, Link, Modal, ModalBody, ModalContent, ModalHeader, Spinner } from '@heroui/react'
import { t } from '@lingui/core/macro'
import { Trans } from '@lingui/react/macro'
import { useQuery } from '@tanstack/react-query'
import { BookOpen as BookOpenIcon } from '@zappicon/react'
import { useState } from 'react'
import { openUrl, platform } from '../../../lib/shell'

/** WinFsp's repository, which its license asks the app to link to. */
const WINFSP_REPOSITORY = 'https://github.com/winfsp/winfsp'

/** WinFsp's notice, which its license asks for in these exact words, in every language. */
const WINFSP_NOTICE = 'WinFsp - Windows File System Proxy, Copyright (C) Bill Zissimopoulos'

/**
 * The app's license, and the licenses of the software that it is built from. They come from
 * public/THIRD_PARTY_NOTICES.txt, which `go run ./build/notices` writes. The file is only
 * loaded when the user asks for it, because it is a megabyte of text.
 */
export default function Licenses() {
    const [isOpen, setIsOpen] = useState(false)
    const notices = useQuery({
        queryKey: ['about', 'notices'],
        queryFn: async () => {
            const res = await fetch('/THIRD_PARTY_NOTICES.txt')
            // The window shows this error in place of the licenses.
            const status = res.status
            if (!res.ok) throw new Error(t`The licenses did not load (${status}).`)
            return await res.text()
        },
        enabled: isOpen,
        staleTime: Number.POSITIVE_INFINITY,
    })

    return (
        <footer className="flex flex-col items-center gap-2 px-6 text-center">
            <p className="max-w-lg text-xs leading-relaxed text-default-500 text-balance">
                <Trans>
                    Rclone UI is open source under the Apache License 2.0, and is built on rclone
                    and other open source software, each under its own license.
                </Trans>
            </p>
            {platform() === 'windows' ? <WinFspNotice /> : null}
            <Button
                size="sm"
                variant="light"
                startContent={<BookOpenIcon className="size-4" />}
                onPress={() => setIsOpen(true)}
                data-focus-visible="false"
            >
                <Trans>Third-party licenses</Trans>
            </Button>
            <Modal isOpen={isOpen} onOpenChange={setIsOpen} size="5xl" scrollBehavior="inside">
                <ModalContent>
                    <ModalHeader>
                        <Trans>Third-party licenses</Trans>
                    </ModalHeader>
                    <ModalBody className="pb-6">
                        {notices.isLoading && <Spinner size="lg" className="py-10" />}
                        {notices.error && (
                            <p className="text-danger">{String(notices.error.message)}</p>
                        )}
                        {notices.data && (
                            <pre className="font-mono whitespace-pre-wrap text-tiny wrap-break-word">
                                {notices.data}
                            </pre>
                        )}
                    </ModalBody>
                </ModalContent>
            </Modal>
        </footer>
    )
}

/**
 * WinFsp's license asks for its notice and a link wherever the app uses it. The notice and the
 * link go into the sentence as they are. Only the words around them are translated.
 */
function WinFspNotice() {
    const notice = WINFSP_NOTICE
    const link = (
        <Link
            as="button"
            type="button"
            size="sm"
            underline="always"
            className="text-xs align-baseline"
            onPress={() => {
                openUrl(WINFSP_REPOSITORY).catch((error: unknown) =>
                    console.error('[Settings] could not open WinFsp', error)
                )
            }}
        >
            github.com/winfsp/winfsp
        </Link>
    )
    return (
        <p className="max-w-lg text-xs leading-relaxed text-default-500 text-balance">
            <Trans comment="{notice} is WinFsp's legal notice and {link} is the address of its repository. Both must stay in the sentence, as they are.">
                Mounts use {notice}, {link}.
            </Trans>
        </p>
    )
}
