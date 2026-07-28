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

### 4. **Error Recovery**
- If token refresh fails, error is saved to `data/qb-token-error.json`
- Dashboard detects error and shows "Reconnect QB" button
- User clicks button → OAuth flow → new tokens saved
- No code deployment needed

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

### After
- ✅ Tokens stored in persistent file
- ✅ Auto-rotate on every refresh (never expires in practice)
- ✅ Dashboard shows reconnect button if needed
- ✅ Survives restarts and redeploys
- ✅ Health status always visible

## Troubleshooting

### QB data shows "Auth expired" 
- Click the "Reconnect QB" button on the dashboard
- Or visit `/api/quickbooks/connect`
- No code changes needed

### Check token freshness
```bash
curl https://bakery-dashboard-2-production.up.railway.app/api/quickbooks/status | jq '.tokenHealth, .tokenExpiresInMinutes'
```

### Manually verify file exists
- Railway dashboard → Data → Storage
- Look for file: `/data/quickbooks-tokens.json`
- Should be > 100 bytes (contains encrypted tokens)

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
