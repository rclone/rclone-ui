import { rpc } from '../api/rpc'

/** Locates a genuine system rclone on PATH (excluding the app's own PATH-integration pointer). */
export async function findSystemRclone(): Promise<string | null> {
    try {
        return (await rpc<string | null>('find_system_rclone')) ?? null
    } catch (error) {
        console.error('[findSystemRclone] error', error)
        return null
    }
}

/** Runs `<path> version` and returns the parsed version string; throws the detailed Rust error
 * (including the macOS Gatekeeper `xattr` hint) when the binary is unusable. */
export async function probeRcloneBinaryOrThrow(path: string): Promise<string> {
    return await rpc<string>('validate_rclone_binary', { path })
}

/** Like probeRcloneBinaryOrThrow, but returns null instead of throwing. */
export async function validateRcloneBinary(path: string): Promise<string | null> {
    try {
        return await probeRcloneBinaryOrThrow(path)
    } catch (error) {
        console.error('[validateRcloneBinary] error', error)
        return null
    }
}

export interface RcloneClassification {
    kind: 'system' | 'managed' | 'custom'
    version: string | null
}

/** Classifies a path as system / managed / custom using canonical comparisons in Rust. */
export async function classifyRclonePath(path: string): Promise<RcloneClassification> {
    try {
        return await rpc<RcloneClassification>('classify_rclone_path', { path })
    } catch (error) {
        console.error('[classifyRclonePath] error', error)
        return { kind: 'custom', version: null }
    }
}

export function compareVersions(version1: string, version2: string): number {
    const parseVersion = (version: string) => {
        // Strip a leading 'v' and any pre-release suffix (e.g. "1.74.0-beta.x") before comparing;
        // otherwise parseInt('v1') is NaN → coerced to 0, silently mis-ordering versions.
        const core = version.trim().replace(/^v/, '').split('-')[0]
        const parts = core.split('.').map((num) => Number.parseInt(num, 10))
        return {
            major: parts[0] || 0,
            minor: parts[1] || 0,
            patch: parts[2] || 0,
        }
    }

    const v1 = parseVersion(version1)
    const v2 = parseVersion(version2)

    if (v1.major !== v2.major) {
        return v1.major > v2.major ? 1 : -1
    }
    if (v1.minor !== v2.minor) {
        return v1.minor > v2.minor ? 1 : -1
    }
    if (v1.patch !== v2.patch) {
        return v1.patch > v2.patch ? 1 : -1
    }
    return 0
}
