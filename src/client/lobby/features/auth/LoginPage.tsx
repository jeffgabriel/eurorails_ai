// features/auth/LoginPage.tsx
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '../../components/ui/form';
import { useAuthStore } from '../../store/auth.store';
import { getErrorMessage } from '../../shared/api';
import type { LoginForm } from '../../shared/types';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, isAuthenticated, error, clearError } = useAuthStore();

  // Preserve only email in sessionStorage (never store password)
  const getStoredEmail = (): string => {
    try {
      return sessionStorage.getItem('loginEmail') || '';
    } catch {
      return '';
    }
  };

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: getStoredEmail(), password: '' },
  });

  useEffect(() => {
    // no-op
  }, []);

  // Save email to sessionStorage on change (never save password)
  // Save even empty strings so clearing the field persists
  useEffect(() => {
    const subscription = form.watch((values) => {
      if (values.email !== undefined) {
        try {
          sessionStorage.setItem('loginEmail', values.email);
        } catch {
          // Ignore storage errors
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // Clear stored email on successful auth
  useEffect(() => {
    if (isAuthenticated) {
      sessionStorage.removeItem('loginEmail');
      navigate('/lobby', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  // Clear error when user starts typing
  useEffect(() => {
    const subscription = form.watch(() => {
      if (error) {
        clearError();
      }
    });
    return () => subscription.unsubscribe();
  }, [form, error, clearError]);

  const onSubmit = async (data: LoginForm) => {
    clearError();

    try {
      await login(data);
      toast.success('Welcome back!');
      // Navigation will happen via useEffect when isAuthenticated becomes true
    } catch (error) {
      // Error will be in the auth store
      // Keep form values - they should persist
    }
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    form.handleSubmit(onSubmit)(e);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-accent mb-2">EuroRails</h1>
          <p className="text-muted-foreground">Multiplayer Railway Strategy</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Welcome Back</CardTitle>
            <CardDescription>
              Sign in to your account to start playing
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={handleFormSubmit} className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input 
                          type="email" 
                          placeholder="Enter your email"
                          {...field}
                          disabled={isLoading}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="Enter your password"
                          {...field}
                          disabled={isLoading}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {error && (
                  <div className="text-sm font-medium" style={{ color: '#dc2626' }}>
                    {getErrorMessage(error)}
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isLoading}
                >
                  {isLoading ? 'Signing In...' : 'Sign In'}
                </Button>
              </form>
            </Form>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Don't have an account?{' '}
                <Link 
                  to="/register" 
                  className="text-accent hover:underline"
                >
                  Create one here
                </Link>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}