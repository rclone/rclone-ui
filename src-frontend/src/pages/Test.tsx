// const store = new LazyStore('store.json')

function Test() {
    // useEffect(() => {
    //     console.log('Test')

    //     let unsubscribe: () => void

    //     store
    //         .onChange(async (key, value) => {
    //             console.log('key', key)
    //             console.log('value', value)

    //             const v = await store.entries()
    //             console.log('v', v)
    //         })
    //         .then((uFn) => {
    //             unsubscribe = uFn
    //         })

    //     return () => {
    //         if (unsubscribe) {
    //             unsubscribe()
    //         }
    //     }
    // }, [])

    return (
        <main className="container bg-blue-500">
            <div className="flex flex-col">
                <h1>Rclone UI</h1>
            </div>
        </main>
    )
}

export default Test
