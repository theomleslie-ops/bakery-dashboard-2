const qbClient = require('./qb-client');

const main = async () => {
  try {
    console.log('Searching for Greenleaf and Alan/Allen vendors...\n');
    const vendors = (await qbClient.query("select Id, DisplayName from Vendor")).Vendor || [];
    
    const matches = vendors.filter(v => 
      /greenleaf|alan|allen/i.test(v.DisplayName)
    );

    if (matches.length === 0) {
      console.log('No exact matches. Here are vendors containing food/produce keywords:\n');
      const keywords = vendors.filter(v => /produce|farm|meat|butcher|seafood|organic|fresh/i.test(v.DisplayName));
      keywords.forEach(v => console.log(`  ${v.DisplayName} (ID: ${v.Id})`));
    } else {
      console.log('Found matches:\n');
      matches.forEach(v => console.log(`  ${v.DisplayName} (ID: ${v.Id})`));
    }
  } catch (e) {
    console.error('Error:', e.message);
  }
};

main();
