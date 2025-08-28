// shared/ErrorBoundary.tsx
import React, { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Error boundary caught an error:', error, errorInfo);
    this.setState({
      error,
      errorInfo
    });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
          <Card className="w-full max-w-lg">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="size-8 text-destructive" />
              </div>
              <CardTitle className="text-xl">Something went wrong</CardTitle>
              <p className="text-sm text-muted-foreground">
                EuroRails encountered an unexpected error
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              {this.state.error && (
                <div className="rounded-lg bg-muted p-4">
                  <h4 className="font-medium text-sm mb-2">Error Details:</h4>
                  <code className="text-xs break-all text-muted-foreground">
                    {this.state.error.message}
                  </code>
                </div>
              )}
              
              <div className="flex gap-2">
                <Button 
                  onClick={this.handleReset}
                  variant="outline"
                  className="flex-1"
                >
                  Try Again
                </Button>
                <Button 
                  onClick={this.handleReload}
                  className="flex-1"
                >
                  <RefreshCw className="size-4 mr-2" />
                  Reload Page
                </Button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                If this error persists, please refresh the page or contact support.
              </p>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}