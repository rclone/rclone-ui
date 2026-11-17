#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

function printUsage() {
    console.log(`Usage: node scripts/rc-request.mjs [options] <path>

Options:
  -X, --method <method>       HTTP method to use (default: POST)
  -b, --base <url>            Base URL (default: http://localhost:5572)
  -q, --query <key=value>     Query parameter to append (repeatable)
  -d, --data <json>           JSON payload string
      --data-file <file>      Path to file containing JSON payload
  -h, --help                  Show this help message

The rc's user and password are read from RCLONE_RC_USER and RCLONE_RC_PASS.

Examples:
  node scripts/rc-request.mjs /rc/noop
  node scripts/rc-request.mjs -q _async=true /job/list
  node scripts/rc-request.mjs -d '{"fs":"rct:","remote":""}' /operations/list`)
}

function parseArgs(argv) {
    const args = {
        baseUrl: process.env.RCLONE_RC_BASE_URL || 'http://localhost:5572',
        method: 'POST',
        path: null,
        query: [],
        data: null,
    }

    for (let i = 0; i < argv.length; i += 1) {
        const value = argv[i]
        switch (value) {
            case '-h':
            case '--help': {
                printUsage()
                process.exit(0)
            }
            case '-X':
            case '--method': {
                const next = argv[++i]
                if (!next) {
                    throw new Error('Expected HTTP method after --method')
                }
                args.method = next.toUpperCase()
                break
            }
            case '-b':
            case '--base': {
                const next = argv[++i]
                if (!next) {
                    throw new Error('Expected URL after --base')
                }
                args.baseUrl = next
                break
            }
            case '-q':
            case '--query': {
                const next = argv[++i]
                if (!next) {
                    throw new Error('Expected key=value after --query')
                }
                args.query.push(next)
                break
            }
            case '-d':
            case '--data': {
                const next = argv[++i]
                if (next === undefined) {
                    throw new Error('Expected JSON string after --data')
                }
                args.data = next
                break
            }
            case '--data-file': {
                const next = argv[++i]
                if (!next) {
                    throw new Error('Expected file path after --data-file')
                }
                args.data = readFileSync(resolve(next), 'utf8')
                break
            }
            default: {
                if (args.path) {
                    throw new Error(`Unexpected argument: ${value}`)
                }
                args.path = value
                break
            }
        }
    }

    if (!args.path) {
        throw new Error('Missing path argument (e.g. /rc/noop)')
    }

    return args
}

function ensurePath(path) {
    if (!path.startsWith('/')) {
        return `/${path}`
    }
    return path
}

function buildUrl(baseUrl, path, queryEntries) {
    const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const url = new URL(ensurePath(path), normalizedBase)

    for (const entry of queryEntries) {
        const [key, ...valueParts] = entry.split('=')
        if (!key) {
            throw new Error(`Invalid query entry "${entry}", expected key=value`)
        }
        const value = valueParts.length > 0 ? valueParts.join('=') : ''
        url.searchParams.append(key, value)
    }

    return url
}

function parseJsonMaybe(input) {
    if (input === null || input === undefined) {
        return null
    }
    const trimmed = input.trim()
    if (!trimmed) {
        return null
    }
    try {
        return JSON.parse(trimmed)
    } catch (error) {
        throw new Error(`Failed to parse JSON payload: ${error?.message || error}`)
    }
}

async function main() {
    let args
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (error) {
        console.error(`[rc-request] ${error.message}`)
        printUsage()
        process.exit(1)
    }

    const url = buildUrl(args.baseUrl, args.path, args.query)
    const payload = parseJsonMaybe(args.data)
    const headers = new Headers()
    if (process.env.RCLONE_RC_USER) {
        const credentials = `${process.env.RCLONE_RC_USER}:${process.env.RCLONE_RC_PASS ?? ''}`
        headers.set('Authorization', `Basic ${Buffer.from(credentials).toString('base64')}`)
    }

    const requestInit = {
        method: args.method,
        headers,
    }

    if (payload !== null) {
        headers.set('Content-Type', 'application/json')
        requestInit.body = JSON.stringify(payload)
    }

    const startedAt = Date.now()
    let response
    try {
        response = await fetch(url, requestInit)
    } catch (error) {
        console.error(`[rc-request] Request failed: ${error?.message || error}`)
        process.exit(1)
    }
    const durationMs = Date.now() - startedAt
    const text = await response.text()

    let parsedBody = null
    if (text) {
        try {
            parsedBody = JSON.parse(text)
        } catch {
            parsedBody = text
        }
    }

    const result = {
        url: url.toString(),
        method: args.method,
        status: response.status,
        statusText: response.statusText,
        durationMs,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsedBody,
    }

    console.log(JSON.stringify(result, null, 2))

    if (!response.ok) {
        process.exitCode = 1
    }
}

main().catch((error) => {
    console.error(`[rc-request] Unexpected error: ${error?.message || error}`)
    process.exit(1)
})
