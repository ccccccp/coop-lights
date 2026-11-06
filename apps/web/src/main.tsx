import { createRoot } from 'react-dom/client'

import { App } from './App'
import { LogPage } from './LogPage'
import { NetworkTestPage } from './NetworkTestPage'

createRoot(document.getElementById('root')!).render(
  location.pathname === '/log' || location.pathname === '/log/' ? (
    <LogPage />
  ) : location.pathname === '/network-test' || location.pathname === '/network-test/' ? (
    <NetworkTestPage />
  ) : (
    <App />
  )
)
