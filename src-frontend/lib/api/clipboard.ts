export async function writeText(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text)
    } catch {
        // Plain HTTP on a LAN address is not a secure context: fall back to the old API.
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
    }
}
