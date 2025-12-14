// authenticatedFetch.ts
// Shared utility for making authenticated API calls with automatic token refresh

interface AuthenticatedFetchOptions extends RequestInit {
  retryOn401?: boolean;
}

/**
 * Makes an authenticated fetch request with automatic token refresh on 401 errors
 * @param url - The URL to fetch
 * @param options - Fetch options (same as standard fetch)
 * @param retryOn401 - Whether to retry on 401 (default: true, set to false to prevent infinite loops)
 * @returns Promise<Response>
 */
export async function authenticatedFetch(
  url: string,
  options: AuthenticatedFetchOptions = {},
  retryOn401: boolean = true
): Promise<Response> {
  const { retryOn401: _, ...fetchOptions } = options;
  
  // Get auth token from localStorage
  const token = localStorage.getItem('eurorails.jwt');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> || {}),
  };
  
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  
  // Make the request
  const response = await fetch(url, {
    ...fetchOptions,
    headers,
  });
  
  // Handle 401 with automatic token refresh
  if (response.status === 401 && retryOn401) {
    const refreshToken = localStorage.getItem('eurorails.refreshToken');
    if (refreshToken) {
      try {
        // Import auth store dynamically to avoid circular dependency
        const { useAuthStore } = await import('../lobby/store/auth.store');
        const refreshed = await useAuthStore.getState().refreshAccessToken();
        
        if (refreshed) {
          // Retry the original request with new token (don't retry again to avoid infinite loop)
          return authenticatedFetch(url, options, false);
        } else {
          console.warn('Token refresh failed, request will fail with 401');
        }
      } catch (refreshError) {
        console.error('Token refresh error:', refreshError);
        // Fall through to return the 401 response
      }
    } else {
      console.warn('No refresh token available for 401 response');
    }
  }
  
  return response;
}

