// shared/NotFound.tsx
import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, ArrowLeft } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { useAuthStore } from '../store/auth.store';

export function NotFound() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);

  useEffect(() => {
    // Log the attempted route for debugging
    console.warn('Route not found:', location.pathname);
  }, [location.pathname]);

  const handleGoHome = () => {
    if (isAuthenticated) {
      navigate('/lobby', { replace: true });
    } else {
      navigate('/login', { replace: true });
    }
  };

  const handleGoBack = () => {
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      handleGoHome();
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-muted">
            <span className="text-2xl">🚂</span>
          </div>
          <CardTitle>Page Not Found</CardTitle>
          <CardDescription>
            The route "{location.pathname}" doesn't exist in EuroRails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            It looks like you've taken a wrong turn on the railway. 
            Let's get you back on track!
          </p>
          
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              onClick={handleGoBack}
              className="flex-1"
            >
              <ArrowLeft className="size-4 mr-2" />
              Go Back
            </Button>
            <Button 
              onClick={handleGoHome}
              className="flex-1"
            >
              <Home className="size-4 mr-2" />
              Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}