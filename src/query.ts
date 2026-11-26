import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { isTransient } from '../lib/errors'
import { needsReconnect, offerReconnect } from '../lib/reconnect'

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
            retry: (failureCount, error) =>
                isTransient(error) && !needsReconnect(error) && failureCount < 3,
        },
    },
})

export default queryClient
