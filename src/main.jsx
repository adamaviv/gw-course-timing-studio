import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { getRecoveryReloadHint } from '../shared/recoveryHints.js';
import './styles.css';

class StorageRecoveryBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
    this.recoveryReloadHint = getRecoveryReloadHint();
    this.handleClearLocalStorage = this.handleClearLocalStorage.bind(this);
    this.handleReloadPage = this.handleReloadPage.bind(this);
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    // Keep a visible console breadcrumb for post-deploy debugging.
    // eslint-disable-next-line no-console
    console.error('Application render failed. Storage recovery fallback enabled.', error);
  }

  handleClearLocalStorage() {
    try {
      window.localStorage.clear();
    } catch {
      // Ignore if browser storage is inaccessible.
    }
    this.setState({ hasError: false }, () => {
      window.location.reload();
    });
  }

  handleReloadPage() {
    window.location.reload();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="app-shell">
          <div className="error-box">
            <p>Saved browser data may be incompatible after an update.</p>
            <p>{this.recoveryReloadHint}</p>
            <div className="error-recovery-actions">
              <button type="button" className="error-recovery-button" onClick={this.handleClearLocalStorage}>
                Clear Local Storage
              </button>
              <button type="button" className="error-reload-button" onClick={this.handleReloadPage}>
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <StorageRecoveryBoundary>
      <App />
    </StorageRecoveryBoundary>
  </React.StrictMode>
);
