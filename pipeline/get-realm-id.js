const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TOKENS_FILE = path.join(__dirname, '..', 'data', 'quickbooks-tokens.json');

const loadTokens = () => {
  try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8')); } catch { return null; }
};

const saveTokens = (t) => {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(t, null, 2));
};

const getValidTokens = async () => {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) throw new Error('QB not connected');
  if (tokens.expires_at && Date.now() < tokens.expires_at - 60_000) return tokens;

  const res = await axios.post(
    'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString(),
    {
      headers: {
        Authorization: `Basic ${Buffer.from(`${process.env.QUICKBOOKS_CLIENT_ID}:${process.env.QUICKBOOKS_CLIENT_SECRET}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }
  );
  const updated = {
    ...tokens,
    access_token: res.data.access_token,
    refresh_token: res.data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + res.data.expires_in * 1000,
  };
  saveTokens(updated);
  return updated;
};

const main = async () => {
  try {
    const tokens = await getValidTokens();
    console.log('Current tokens:', JSON.stringify(tokens, null, 2));
    
    if (!tokens.realmId) {
      console.log('\n→ Fetching realmId from QB company info...');
      const res = await axios.get(
        `https://quickbooks.api.intuit.com/v2/company/companyinfo/123`,
        {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        }
      ).catch(e => {
        // Try to extract realmId from error response
        if (e.response?.data?.fault?.error?.[0]?.detail) {
          console.log('Error response:', e.response.data);
        }
        throw e;
      });
      console.log('Company info:', res.data);
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
};

main();
