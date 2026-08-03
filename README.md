# Bakery Margin Analysis API

Flask API serving cost and margin analysis for the top 20 bakery products.

## Features

- **Real ingredient costs** sourced from 20+ invoices (Chef's Warehouse, Greenleaf, etc.)
- **Accurate recipe costing** using base dough formulas and portion weights
- **Pre-ferment expansion** (Levain, Poolish) calculated into final recipes
- **Compound recipes** supported (e.g., Breakfast Bar with bottom + top layers)
- **75.5% blended gross margin** across top 20 products

## API Endpoints

- `GET /` - API home and endpoint list
- `GET /api/summary` - Blended margin summary
- `GET /api/products` - All 20 products with costs and margins
- `GET /api/products/<rank>` - Individual product by rank (1-20)
- `GET /api/download` - Download full JSON analysis
- `GET /health` - Health check

## Data

**Current Analysis:**
- 33,355 units sold across top 20 products
- $240,916.50 total revenue
- $59,026.59 total COGS
- $181,889.91 gross profit
- **75.5% blended gross margin**

**Ingredients with Real Prices:**
- All Purpose Flour: $0.96/kg
- Butter: $8.29/kg
- Chocolate Chips: $23.37/kg
- Eggs: $1.94/kg
- Blueberries (Frozen): $5.30/kg
- + 15 more items from actual invoices

**Items with Estimates:**
- Bananas: $0.70/kg
- Walnuts: $15.00/kg
- Feta: $10.00/kg
- Flax Seeds: $8.00/kg
- Teff Flour: $4.00/kg

## Deployment to Railways

1. Connect the GitHub repository to Railways
2. Set the root directory to the branch with this code
3. Railways will detect the `Procfile` and `requirements.txt`
4. Deploy automatically

The API will start on the PORT environment variable (default 5000).

## Local Development

```bash
pip install -r requirements.txt
python app.py
```

Then visit `http://localhost:5000` in your browser.

## Notes

- Analysis generated: 2026-08-03
- Real Square sales data (top 20 by revenue)
- Blended gross margin: 75.5%
- 20+ ingredient prices from actual invoices
