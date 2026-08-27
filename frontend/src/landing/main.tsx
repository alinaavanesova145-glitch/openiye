import React from 'react'
import ReactDOM from 'react-dom/client'
import LandingApp from './LandingApp'
import { ErrorBoundary } from '@lib/ErrorBoundary'
import '../index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="IYE landing page">
      <LandingApp />
    </ErrorBoundary>
  </React.StrictMode>,
)
