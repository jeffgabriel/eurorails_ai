// features/auth/LoginPage.tsx
import { useEffect, useState } from 'react';
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
import type { LoginForm } from '../../shared/types';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading, isAuthenticated, error, clearError } = useAuthStore();

  // Preserve form values in sessionStorage to survive unmounts
  const getStoredFormValues = (): LoginForm => {
    try {
      const stored = sessionStorage.getItem('loginFormValues');
      return stored ? JSON.parse(stored) : { email: '', password: '' };
    } catch {
      return { email: '', password: '' };
    }
  };

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: getStoredFormValues(),
  });

  useEffect(() => {
    console.log('[LoginPage] Mounted');
    return () => console.log('[LoginPage] Unmounted');
  }, []);

  useEffect(() => {
    console.log('[LoginPage] isLoading:', isLoading, 'isAuthenticated:', isAuthenticated, 'error:', error);
  }, [isLoading, isAuthenticated, error]);

  // Save form values to sessionStorage on change
  useEffect(() => {
    const subscription = form.watch((values) => {
      sessionStorage.setItem('loginFormValues', JSON.stringify(values));
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // Clear stored values on successful auth
  useEffect(() => {
    if (isAuthenticated) {
      sessionStorage.removeItem('loginFormValues');
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
                    Username or password are incorrect
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