import { getCurrentWindow } from '@tauri-apps/api/window'
import {
    COPY_VERIFY_ACK,
    COPY_VERIFY_COMMAND,
    type CopyVerifyAck,
    type CopyVerifyCommand,
    emitToMain,
} from '../events'
import type { CopyArgs } from '../rclone/requests'

type CopyVerifyRequest =
    | { type: 'start'; args: CopyArgs }
    | { type: 'repair'; operationId: string }
    | { type: 'verify-again'; operationId: string }
    | { type: 'stop'; operationId: string }

async function request(command: CopyVerifyRequest): Promise<CopyVerifyAck> {
    const requestId = crypto.randomUUID()
    const fullCommand = { ...command, requestId } as CopyVerifyCommand
    const window = getCurrentWindow()

    return new Promise<CopyVerifyAck>((resolve, reject) => {
        let unlisten: (() => void) | undefined
        let settled = false
        const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            unlisten?.()
            reject(new Error('Timed out waiting for the Copy + Verify coordinator'))
        }, 15_000)

        window
            .listen<CopyVerifyAck>(COPY_VERIFY_ACK, (event) => {
                if (event.payload.requestId !== requestId || settled) return
                settled = true
                clearTimeout(timeout)
                unlisten?.()
                resolve(event.payload)
            })
            .then((dispose) => {
                unlisten = dispose
                return emitToMain(COPY_VERIFY_COMMAND, fullCommand)
            })
            .catch((error) => {
                if (settled) return
                settled = true
                clearTimeout(timeout)
                unlisten?.()
                reject(error)
            })
    })
}

async function requireSuccess(command: CopyVerifyRequest): Promise<string | void> {
    const ack = await request(command)
    if (!ack.ok) throw new Error(ack.error || 'Copy + Verify command failed')
    return ack.operationId
}

export function startCopyVerify(args: CopyArgs): Promise<string> {
    return requireSuccess({ type: 'start', args }) as Promise<string>
}

export async function repairCopyVerify(operationId: string): Promise<void> {
    await requireSuccess({ type: 'repair', operationId })
}

export async function verifyAgainCopyVerify(operationId: string): Promise<void> {
    await requireSuccess({ type: 'verify-again', operationId })
}

export async function stopCopyVerify(operationId: string): Promise<void> {
    await requireSuccess({ type: 'stop', operationId })
}
