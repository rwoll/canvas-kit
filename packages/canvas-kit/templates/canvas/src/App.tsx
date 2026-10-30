import { createCanvasHooks } from '@rwoll/canvas-kit/react'
import type canvas from '../server/canvas.ts'
import './App.css'

const { useCanvas, useAction } = createCanvasHooks<typeof canvas>()

const TITLE = '__TITLE__'

function App() {
  const { state, status } = useCanvas()
  const [increment, { pending, error }] = useAction('increment')

  return (
    <main>
      <h1>{TITLE}</h1>
      <p>
        Edit <code>src/App.tsx</code> for the UI and <code>server/canvas.ts</code> for state and
        actions.
      </p>
      <button type="button" disabled={pending} onClick={() => increment()}>
        Count is {state.count}
      </button>
      {error && <p role="alert">{error.message}</p>}
      <p className="connection" role="status">
        {status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline'}
      </p>
    </main>
  )
}

export default App
