const axios = require('axios');

const SQUARE_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const QB_REALM_ID = process.env.QB_REALM_ID;
const QB_REFRESH_TOKEN = process.env.QUICKBOOKS_REFRESH_TOKEN;
const QB_CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
const QB_CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;

const SQUARE_API = 'https://connect.squareup.com/v2';
const QB_API = 'https://quickbooks.api.intuit.com';

// Square API calls
const getSquareLocations = async () => {
  try {
    const response = await axios.get(`${SQUARE_API}/locations`, {
      headers: {
        'Authorization': `Bearer ${SQUARE_TOKEN}`,
        'Square-Version': '2026-07-01',
      },
    });
    return response.data;
  } catch (err) {
    console.error('Square locations error:', err.message);
    return null;
  }
};

const getSquareOrders = async (locationId, startTime, endTime) => {
  try {
    const response = await axios.post(`${SQUARE_API}/orders/search`, {
      location_ids: [locationId],
      query: {
        filter: {
          date_time_filter: {
            closed_at: {
              start_at: startTime,
              end_at: endTime,
            },
          },
        },
      },
    }, {
      headers: {
        'Authorization': `Bearer ${SQUARE_TOKEN}`,
        'Square-Version': '2026-07-01',
      },
    });
    return response.data;
  } catch (err) {
    console.error('Square orders error:', err.message);
    return null;
  }
};

// QuickBooks API calls
const getQuickBooksReport = async (startDate, endDate) => {
  try {
    const response = await axios.get(
      `${QB_API}/v2/company/${QB_REALM_ID}/reports/ProfitAndLoss`,
      {
        params: {
          start_date: startDate,
          end_date: endDate,
          summarize_column_by: 'Month',
        },
        headers: {
          'Authorization': `Bearer ${await getQBAccessToken()}`,
          'Accept': 'application/json',
        },
      }
    );
    return response.data;
  } catch (err) {
    console.error('QB report error:', err.message);
    return null;
  }
};

let cachedQBToken = null;
let tokenExpiry = null;

const getQBAccessToken = async () => {
  if (cachedQBToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedQBToken;
  }

  try {
    const response = await axios.post(
      'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: QB_REFRESH_TOKEN,
      }).toString(),
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    cachedQBToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    return cachedQBToken;
  } catch (err) {
    console.error('QB token refresh error:', err.message);
    throw err;
  }
};

module.exports = {
  getSquareLocations,
  getSquareOrders,
  getQuickBooksReport,
  getQBAccessToken,
};
