import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@rwoll/canvas-kit/styles.css'
import '@examples/ui/theme.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
