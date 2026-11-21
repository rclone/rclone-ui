import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isTransient } from '../lib/errors'
import { needsReconnect, offerReconnect } from '../lib/reconnect'

// When the core reports that a remote's sign-in has expired, offer to reconnect the remote, on
// whichever page made the call. After it reconnects, all queries are fetched again.
function reconnectOnError(error: unknown) {
    const remote = needsReconnect(error)
    if (!remote) return
    offerReconnect(remote).then((reconnected) => {
        if (reconnected) queryClient.invalidateQueries()
    })
}

const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError: reconnectOnError }),
    mutationCache: new MutationCache({ onError: reconnectOnError }),
    defaultOptions: {
        queries: {
            // Retry only errors that might go away. A missing path or an invalid argument is shown
            // at once.
            retry: (failureCount, error) =>
                isTransient(error) && !needsReconnect(error) && failureCount < 3,
        },
    },
})

export default queryClient
