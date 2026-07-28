const { Composio } = require('@composio/core');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA_DIR = 'data';
const CONNECTIONS_FILE = path.join(DATA_DIR, 'composio-connections.json');

let composioClient;

const loadConnections = () => {
  try {
    return JSON.parse(fs.readFileSync(CONNECTIONS_FILE, 'utf-8'));
  } catch {
    return { square: null, quickbooks: null };
  }
};

const saveConnections = (connections) => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(connections, null, 2));
  } catch (e) {
    console.warn('Failed to save connections:', e.message);
  }
};

const initComposio = async () => {
  if (composioClient) return composioClient;

  const apiKey = process.env.COMPOSIO_API_KEY;
  const userId = process.env.USER_ID || 'default-user';

  if (!apiKey) {
    throw new Error('COMPOSIO_API_KEY not set in .env');
  }

  composioClient = new Composio({ apiKey });
  return composioClient;
};

const getSquareConnection = async () => {
  const client = await initComposio();
  const connections = loadConnections();

  if (connections.square) {
    return connections.square;
  }

  const userId = process.env.USER_ID || 'default-user';
  const integrations = await client.getIntegrations({ query: 'square' });
  const squareIntegration = integrations?.[0];

  if (!squareIntegration) {
    throw new Error('Square integration not found in Composio. Set up the integration first.');
  }

  try {
    const conn = await client.createConnection({
      integrationId: squareIntegration.id,
      userId,
      authMode: 'OAUTH2',
    });

    connections.square = conn.connectionId;
    saveConnections(connections);
    return conn.connectionId;
  } catch (err) {
    throw new Error(`Failed to create Square connection: ${err.message}`);
  }
};

const getQuickBooksConnection = async () => {
  const client = await initComposio();
  const connections = loadConnections();

  if (connections.quickbooks) {
    console.log('Using cached QB connection ID:', connections.quickbooks);
    return connections.quickbooks;
  }

  try {
    const userId = process.env.USER_ID || 'default-user';
    console.log('Looking for existing QB connection in Composio for user:', userId);

    // Try to find existing QB connection using HTTP API directly
    const existingConnections = await axios.get(
      'https://api.composio.dev/v1/connections',
      {
        headers: { 'Authorization': `Bearer ${process.env.COMPOSIO_API_KEY}` },
        params: { userId },
      }
    ).then(r => r.data?.data || r.data?.connections || []).catch(err => {
      console.warn('Could not fetch connections from Composio API:', err.message);
      return [];
    });
    console.log('Found', existingConnections?.length || 0, 'total connections');

    if (existingConnections && existingConnections.length > 0) {
      console.log('Available connections:', existingConnections.map(c => ({
        id: c.id,
        integration: c.integration?.name || c.integration?.platform,
      })));
    }

    const qbConnection = existingConnections?.find(c => {
      const intName = (c.integration?.name || c.integration?.platform || '').toLowerCase();
      const isQB = intName.includes('quickbooks') || intName.includes('intuit');
      console.log('Checking connection:', intName, '-> is QB?', isQB);
      return isQB;
    });

    if (qbConnection) {
      console.log('✅ Found existing QB connection:', qbConnection.id);
      connections.quickbooks = qbConnection.id;
      saveConnections(connections);
      return qbConnection.id;
    }

    console.log('No existing QB connection found, will create new one');

    // If no existing connection, create a new one
    const integrations = await client.getIntegrations({ query: 'quickbooks' });
    const qbIntegration = integrations?.[0];

    if (!qbIntegration) {
      throw new Error('QuickBooks integration not found in Composio. Set up the integration first.');
    }

    console.log('Creating new QB connection...');
    const conn = await client.createConnection({
      integrationId: qbIntegration.id,
      userId,
      authMode: 'OAUTH2',
    });

    connections.quickbooks = conn.connectionId;
    saveConnections(connections);
    return conn.connectionId;
  } catch (err) {
    console.error('QB connection error:', err.message);
    throw new Error(`Failed to get QuickBooks connection: ${err.message}`);
  }
};

const executeSquareAction = async (action, payload) => {
  const connectionId = await getSquareConnection();
  const client = await initComposio();

  try {
    const response = await client.executeAction({
      connectionId,
      action,
      ...payload,
    });
    return response;
  } catch (err) {
    throw new Error(`Square action '${action}' failed: ${err.message}`);
  }
};

const executeQuickBooksAction = async (action, payload) => {
  const connectionId = await getQuickBooksConnection();
  const client = await initComposio();

  try {
    const response = await client.executeAction({
      connectionId,
      action,
      ...payload,
    });
    return response;
  } catch (err) {
    throw new Error(`QuickBooks action '${action}' failed: ${err.message}`);
  }
};

const getSquareTimecards = async (startDate, endDate) => {
  return await executeSquareAction('square_search_timecards', {
    start_at: `${startDate}T00:00:00Z`,
    end_at: `${endDate}T00:00:00Z`,
    status: 'CLOSED',
  });
};

const getSquareTeamMembers = async () => {
  return await executeSquareAction('square_search_team_members', {});
};

const getSquareOrders = async (locationId, beginTime, endTime) => {
  return await executeSquareAction('square_search_orders', {
    location_ids: [locationId],
    query: {
      filter: {
        date_time_filter: {
          closed_at: {
            start_at: beginTime,
            end_at: endTime,
          },
        },
      },
    },
  });
};

const getQuickBooksReport = async (query) => {
  return await executeQuickBooksAction('quickbooks_get_report', {
    query,
  });
};

const getQuickBooksAccounts = async (realmId) => {
  return await executeQuickBooksAction('quickbooks_list_accounts', {
    realm_id: realmId,
  });
};

const disconnectSquare = async () => {
  const connections = loadConnections();
  if (connections.square) {
    const client = await initComposio();
    try {
      await client.deleteConnection(connections.square);
    } catch (err) {
      console.warn('Failed to disconnect Square:', err.message);
    }
    connections.square = null;
    saveConnections(connections);
  }
};

const disconnectQuickBooks = async () => {
  const connections = loadConnections();
  if (connections.quickbooks) {
    const client = await initComposio();
    try {
      await client.deleteConnection(connections.quickbooks);
    } catch (err) {
      console.warn('Failed to disconnect QuickBooks:', err.message);
    }
    connections.quickbooks = null;
    saveConnections(connections);
  }
};

const getConnectionStatus = () => {
  const connections = loadConnections();
  return {
    square: !!connections.square,
    quickbooks: !!connections.quickbooks,
  };
};

module.exports = {
  initComposio,
  getSquareConnection,
  getQuickBooksConnection,
  executeSquareAction,
  executeQuickBooksAction,
  getSquareTimecards,
  getSquareTeamMembers,
  getSquareOrders,
  getQuickBooksReport,
  getQuickBooksAccounts,
  disconnectSquare,
  disconnectQuickBooks,
  getConnectionStatus,
};
