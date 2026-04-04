import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorInfo: string | null;
}

export class ErrorBoundary extends Component<any, any> {
  constructor(props: any) {
    super(props);
    // @ts-ignore
    this.state = { hasError: false, errorInfo: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, errorInfo: error.message };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    // @ts-ignore
    if (this.state.hasError) {
      let displayMessage = 'Something went wrong. Please try refreshing the page.';
      try {
        // @ts-ignore
        const parsed = JSON.parse(this.state.errorInfo || '');
        if (parsed.error) {
          displayMessage = `Connection Error: ${parsed.error}. Please check your internet connection.`;
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden max-w-md w-full p-6 text-center">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Application Error</h2>
            <p className="text-gray-600 mb-6">{displayMessage}</p>
            <button 
              onClick={() => window.location.reload()} 
              className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg font-medium transition-all duration-200 bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
            >
              Refresh Application
            </button>
          </div>
        </div>
      );
    }

    // @ts-ignore
    return this.props.children;
  }
}
