import { createRoot } from 'react-dom/client'

import { App } from './App'
import { LogPage } from './LogPage'

createRoot(document.getElementById('root')!).render(
  location.pathname === '/log' || location.pathname === '/log/' ? <LogPage /> : <App />
)
