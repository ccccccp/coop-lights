import { createRoot } from 'react-dom/client'

import { App } from './App'
import { startCoopLights } from './bootstrap'

Object.defineProperty(window, 'startCoopLights', { value: startCoopLights, configurable: false, writable: false })
createRoot(document.getElementById('root')!).render(<App />)
