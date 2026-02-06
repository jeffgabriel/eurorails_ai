# Rate Limiting Decision for Email Verification Resend Endpoint

## Context
During code review of PR #208, a suggestion was made to add rate limiting to the `/auth/resend-verification` endpoint to prevent potential email spam.

## Current Implementation
The resend verification endpoint currently:
- Requires authentication (user must be logged in)
- Checks if user is already verified (returns early if they are)
- Generates a new token and invalidates previous ones
- Sends verification email via Resend API

## Decision: Defer Rate Limiting Implementation

### Rationale
1. **Resend API has built-in rate limiting**: Resend enforces their own rate limits on email sending, providing a first layer of protection
2. **Authentication requirement**: Users must be logged in to resend, limiting the attack surface
3. **Limited use case**: This is a one-time verification flow - users rarely need to resend multiple times
4. **Scope management**: Adding rate limiting infrastructure for a single endpoint adds complexity that can be deferred
5. **Monitoring first**: We should monitor actual usage patterns before implementing limits

### Future Considerations
If abuse is detected or usage patterns warrant it, we can add rate limiting using:
- The existing `RateLimitService` (currently used for chat messages)
- A dedicated email rate limiting table with similar structure to `chat_rate_limits`
- Suggested limit: 3 resends per hour per user (as suggested in review)

### Monitoring
We should track:
- Number of resend requests per user
- Time between resend requests
- Overall daily resend volume

## Status
**Deferred** - Will be implemented if abuse is detected through monitoring.

## Related
- PR #208 Review Comments
- `src/server/services/rateLimitService.ts` (for future implementation reference)
- See also: `docs/EMAIL_VERIFICATION_SETUP.md` for other PR #208 review fixes
