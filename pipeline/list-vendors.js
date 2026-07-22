const qbClient = require('./qb-client');

const main = async () => {
  try {
    console.log('Fetching all vendors from QuickBooks...\n');
    const vendors = (await qbClient.query("select Id, DisplayName from Vendor")).Vendor || [];
    
    console.log(`Found ${vendors.length} vendors:\n`);
    vendors.forEach((v, i) => {
      console.log(`${String(i + 1).padStart(3)}: ${v.DisplayName} (ID: ${v.Id})`);
    });
  } catch (e) {
    console.error('Error:', e.message);
  }
};

main();
