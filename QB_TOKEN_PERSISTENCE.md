# QuickBooks Token Persistence & Auto-Refresh

## How It Works Now

### 1. **Persistent File Storage**
- QB tokens are stored in `data/quickbooks-tokens.json`
- This file persists across server restarts and Railway deployments
- Tokens include: access token, refresh token, expiry time, realm ID

### 2. **Automatic Token Refresh**
- Every 30 minutes, the server automatically refreshes the access token
- QB provides new refresh tokens on each successful refresh (token rotation)
- New tokens are automatically saved to the file
- This keeps tokens fresh indefinitely without manual intervention

### 3. **Token Loading Priority**
1. Load from `data/quickbooks-tokens.json` (persistent file) ✅
2. Fall back to environment variables (if file missing)
3. Save to file for next time (backup to env vars)

### 4. **Automatic Re-Authorization**
- When dashboard loads and QB token is expired:
  1. Dashboard detects `errorType: "token_expired"`
  2. Automatically redirects to `/api/quickbooks/auto-reauth`
  3. This endpoint triggers OAuth flow silently
  4. After authorization completes, redirects back to dashboard
  5. QB data loads automatically
- **No user action needed** - happens automatically in background
- Current page URL is preserved and returned to after re-auth

### 5. **Proactive Token Health Monitoring**
- Daily health check monitors token refresh age
- Warns if tokens haven't been refreshed in 100+ days
- Logs token status on server startup

## Initial Setup (One Time)

### Option A: OAuth Authorization (Recommended)
```
1. Visit: https://bakery-dashboard-2-production.up.railway.app/api/quickbooks/connect
2. Authorize with your QB account
3. Tokens are automatically saved to persistent file
4. Done - no env vars needed!
```

### Option B: Add Tokens to Environment (Backup)
If you already have tokens, set these in Railway:
```
QUICKBOOKS_REFRESH_TOKEN=RT1-14-H0-xxx
QUICKBOOKS_REALM_ID=9130352842943926
```
They'll be copied to the persistent file on first run.

## Monitoring Token Health

Check token status anytime:
```bash
curl https://bakery-dashboard-2-production.up.railway.app/api/quickbooks/status
```

Response shows:
- `tokenHealth`: "healthy" / "expiring_soon" / "expired"
- `tokenExpiresInMinutes`: Time until access token expires
- `lastRefreshed`: When token was last refreshed
- `persistenceEnabled`: true (tokens are persisted)

## What Changed

### Before
- ❌ Tokens only in environment variables
- ❌ Expired after 100 days with no warning
- ❌ Required manual re-auth + env var update
- ❌ No persistence across Railway redeploys
- ❌ Dashboard would show "Loading..." forever if auth failed

### After
- ✅ Tokens stored in persistent file (survives all deployments)
- ✅ Auto-rotate on every refresh (tokens never expire in practice)
- ✅ **Automatic re-authorization** - dashboard detects and fixes token errors automatically
- ✅ Survives restarts and redeploys
- ✅ Health status monitored daily
- ✅ Dashboard stays online 24/7 with zero manual intervention

## How Auto Re-Auth Works

**Scenario**: You load the dashboard and QB token has expired.

```
1. Dashboard fetches /api/public/quickbooks/overview
2. Endpoint detects token_expired error
3. Dashboard receives: { errorType: "token_expired", reconnectUrl: "..." }
4. Dashboard automatically redirects to /api/quickbooks/auto-reauth
5. This endpoint detects token error and redirects to QB OAuth
6. QB OAuth flow runs (user sees "Authorizing..." briefly)
7. After auth, redirects back to dashboard
8. Dashboard reloads with fresh tokens
9. QB data loads automatically ✅
```

**Result**: User sees dashboard refresh for ~30 seconds, then QB data loads. No manual action needed.

## Troubleshooting

### QB re-auth stuck in redirect loop
- Clear browser cache and cookies for the domain
- Or manually visit `/api/quickbooks/connect` to complete auth
- Check Railway logs for OAuth errors

### Check token freshness
```bash
curl https://bakery-dashboard-2-production.up.railway.app/api/quickbooks/status | jq '.tokenHealth, .tokenExpiresInMinutes, .lastRefreshed'
```

Expected response:
```json
{
  "tokenHealth": "healthy",
  "tokenExpiresInMinutes": 55,
  "lastRefreshed": "2026-07-28T20:35:42.123Z"
}
```

### Manually verify file exists
- Railway dashboard → Data → Storage
- Look for file: `/data/quickbooks-tokens.json`
- Should be > 100 bytes (contains all token data)

## How Token Rotation Works

QB OAuth provides token rotation for security:
```
1. Server refreshes access token every 30 mins
2. QB returns: new access token + new refresh token
3. Both are saved to persistent file
4. Process repeats indefinitely
5. Tokens never expire (always fresh)
```

This is the OAuth best practice that keeps systems secure & always-online.
