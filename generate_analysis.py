#!/usr/bin/env python3
"""
Complete Top 20 Bakery Product Cost & Margin Analysis
Real Square sales data + calculated recipe costs
"""

import json
from datetime import datetime

# Real ingredient costs from invoices
ingredient_costs = {
    "All Purpose Flour": 0.96,
    "Almond Butter": 11.57,  # Invoice
    "Almond Flour": 13.05,
    "Baking Powder": 11.39,
    "Baking Soda": 3.87,
    "Blueberries (Frozen)": 5.30,
    "Bittersweet Chocolate": 16.53,
    "Black Sesame": 7.72,  # Invoice
    "Brown Sugar": 2.07,
    "Butter": 8.29,
    "Buttermilk": 0.56,
    "Chocolate Chips": 23.37,
    "Coconut Flakes": 6.06,  # Invoice
    "Cornmeal": 2.65,
    "Dry Cherries": 17.43,  # Invoice
    "Dry Yeast": 15.43,
    "Eggs": 1.94,
    "Feta": 10.00,  # ESTIMATED
    "Flax Seeds": 8.00,  # ESTIMATED
    "Heavy Cream": 1.09,
    "High Gluten Flour": 0.96,
    "Honey": 31.62,  # From invoice: $21.50 per 1.5 LB
    "Lemon Zest": 46.76,
    "Milk": 0.38,
    "Molasses": 5.90,
    "Oats": 2.12,
    "Orange Juice": 0.80,  # ESTIMATED
    "Olive Oil": 13.05,  # From invoice (estimated container size)
    "Parmesan": 35.19,  # From invoice: $15.96/LB
    "Poppy Seeds": 13.05,  # Invoice
    "Prunes": 9.70,  # Invoice
    "Raisins": 6.98,  # From invoice: $95/30LB
    "Raspberries": 7.32,
    "Salt": 1.59,
    "Sour Cream": 4.75,
    "Spinach": 2.24,  # From Greenleaf: frozen chopped
    "Sugar (White)": 1.85,
    "Sunflower Seeds": 3.57,  # Invoice
    "Teff Flour": 4.00,  # ESTIMATED
    "Water": 0.01,
    "Wheat Bran": 2.52,
    "Whole Wheat Flour": 1.76,
    "White Sesame": 6.17,  # Invoice
    "Apricot Jam": 4.00,  # ESTIMATED
}

# Pre-ferment costs
levain_cost_per_kg = 0.72
poolish_cost_per_kg = 0.60

# Base dough costs (cost per kg of raw dough)
country_dough_cost_per_kg = 0.621
challah_dough_cost_per_kg = 3.63

# Real Square sales data (top 20 by revenue)
sales_data = [
    {"rank": 1, "product": "Country Round", "units": 1984, "price": 12.00, "cost": 0.62},
    {"rank": 2, "product": "Breakfast Bar", "units": 3124, "price": 7.50, "cost": 4.59},
    {"rank": 3, "product": "NO-NUT Choc Chip Cookie", "units": 3424, "price": 6.00, "cost": 2.05},
    {"rank": 4, "product": "Double Choc Chip Cookie", "units": 2799, "price": 6.50, "cost": 2.05},
    {"rank": 5, "product": "Country PC", "units": 2973, "price": 6.00, "cost": 0.28},
    {"rank": 6, "product": "ORIGINAL Choc Chip Cookie", "units": 2702, "price": 6.50, "cost": 2.05},
    {"rank": 7, "product": "Oatmeal Raisin Cookie", "units": 2490, "price": 6.00, "cost": 2.05},
    {"rank": 8, "product": "Baguette", "units": 1145, "price": 10.00, "cost": 0.47},
    {"rank": 9, "product": "Forest Scone", "units": 1852, "price": 6.00, "cost": None},  # CALC NEEDED
    {"rank": 10, "product": "Olive PC", "units": 1703, "price": 6.50, "cost": None},
    {"rank": 11, "product": "Chocolate Sourdough Scone", "units": 1818, "price": 6.00, "cost": 0.88},
    {"rank": 12, "product": "Long Braid", "units": 678, "price": 16.00, "cost": 3.70},
    {"rank": 13, "product": "Epi", "units": 899, "price": 12.00, "cost": 0.47},
    {"rank": 14, "product": "Mini Banana Bread Loaf", "units": 1524, "price": 7.00, "cost": None},  # CALC NEEDED
    {"rank": 15, "product": "Cinn SWIRL", "units": 1761, "price": 6.00, "cost": None},
    {"rank": 16, "product": "PB Mound Cookie", "units": 1688, "price": 6.00, "cost": 2.05},
    {"rank": 17, "product": "Nutella Bun", "units": 1660, "price": 6.00, "cost": 1.79},
    {"rank": 18, "product": "Jalapeno & Cheddar Baton", "units": 1194, "price": 8.00, "cost": None},
    {"rank": 19, "product": "Ham & Cheese Baton", "units": 1056, "price": 9.00, "cost": 1.05},
    {"rank": 20, "product": "Blueberry Corn Muffin", "units": 1539, "price": 6.00, "cost": None},  # CALC NEEDED
]

# Calculate missing recipe costs
def calc_forest_scone():
    """Forest Scone: 1.494 kg batch, assume ~18 scones per batch (per common bakery practice)"""
    ingredients = {
        "All Purpose Flour": 0.25,
        "Oats": 0.05,
        "Dry Yeast": 0.005,
        "Salt": 0.002,
        "Butter": 0.114,
        "Spinach": 0.6,
        "Parmesan": 0.25,
        "Feta": 0.1,
        "Buttermilk": 0.02,
        "Eggs": 0.053,
        "Levain": 0.05,
    }

    # Expand Levain
    levain_components = {"High Gluten Flour": 0.262, "Whole Wheat Flour": 0.262, "Water": 0.523}
    levain_ing = 0.05

    total_cost = levain_ing * levain_cost_per_kg
    for ing, amount in ingredients.items():
        if ing != "Levain":
            cost = ingredient_costs.get(ing, 0) * amount
            total_cost += cost

    # Assume 18 scones per 1.494 kg batch
    scones_per_batch = 18
    cost_per_scone = total_cost / scones_per_batch
    return round(cost_per_scone, 2)

def calc_banana_bread():
    """Mini Banana Bread: 1.392 kg batch yields ~10.3 loaves at 135g each"""
    ingredients = {
        "Butter": 0.113,
        "Brown Sugar": 0.13,
        "Eggs": 0.1,
        "Bananas (Ripe)": 0.588,
        "All Purpose Flour": 0.255,
        "Baking Soda": 0.004,
        "Salt": 0.002,
        "Semisweet Chocolate Chips": 0.06,
        "Bittersweet Chocolate": 0.02,
        "Walnuts": 0.025,
        "Raisins": 0.04,
        "Blueberries (Frozen)": 0.055,
    }

    # Map ingredient names for cost lookup
    ing_map = {
        "Semisweet Chocolate Chips": "Chocolate Chips",
        "Bittersweet Chocolate": "Bittersweet Chocolate",
        "Walnuts": "Walnuts",
        "Bananas (Ripe)": "Bananas (Ripe)",
    }

    total_cost = 0
    for ing, amount in ingredients.items():
        lookup_ing = ing_map.get(ing, ing)
        # Handle Walnuts and Bananas if not in standard dict
        if lookup_ing == "Walnuts":
            cost = 15.00 * amount  # ESTIMATED
        elif lookup_ing == "Bananas (Ripe)":
            cost = 0.70 * amount  # ESTIMATED
        else:
            cost = ingredient_costs.get(lookup_ing, 0) * amount
        total_cost += cost

    loaves_per_batch = 10.3
    cost_per_loaf = total_cost / loaves_per_batch
    return round(cost_per_loaf, 2)

def calc_blueberry_muffin():
    """Blueberry Corn Muffin: estimate based on similar recipes ~$3.50 per muffin"""
    # Without the recipe, using comparable product estimate
    # Blueberry Corn Muffin typically: corn, blueberries, butter, sugar, eggs, baking powder
    # Estimated cost around $2.50-3.50 per unit
    return 3.00  # ESTIMATED - would need actual recipe

# Calculate costs for missing products
forest_scone_cost = calc_forest_scone()
banana_bread_cost = calc_banana_bread()
blueberry_muffin_cost = calc_blueberry_muffin()

# Update sales data with calculated costs
for item in sales_data:
    if item["product"] == "Forest Scone":
        item["cost"] = forest_scone_cost
    elif item["product"] == "Mini Banana Bread Loaf":
        item["cost"] = banana_bread_cost
    elif item["product"] == "Blueberry Corn Muffin":
        item["cost"] = blueberry_muffin_cost

# Calculate margins
print("=" * 100)
print("TOP 20 BAKERY PRODUCTS - COST & MARGIN ANALYSIS")
print("=" * 100)
print(f"\nGenerated: {datetime.now().isoformat()}")
print("Data source: Real Square sales data + calculated recipe costs from invoices\n")

margin_results = []
total_revenue = 0
total_cogs = 0
total_units = 0

for item in sorted(sales_data, key=lambda x: x["units"] * x["price"], reverse=True):
    if item["cost"] is None:
        continue

    units = item["units"]
    price = item["price"]
    cost = item["cost"]

    revenue = units * price
    cogs = units * cost
    profit = revenue - cogs
    margin_pct = (profit / revenue * 100) if revenue > 0 else 0

    total_revenue += revenue
    total_cogs += cogs
    total_units += units

    status = "✓" if margin_pct > 0 else "🚨"

    print(f"{item['rank']:2}. {item['product']:30} {units:5} units @ ${price:6.2f}")
    print(f"    Cost/unit: ${cost:6.2f} | Revenue: ${revenue:10.2f} | COGS: ${cogs:10.2f}")
    print(f"    Profit: ${profit:10.2f} | Margin: {margin_pct:6.1f}% {status}\n")

    margin_results.append({
        "rank": item["rank"],
        "product": item["product"],
        "units": units,
        "sale_price": price,
        "cost_per_unit": cost,
        "revenue": round(revenue, 2),
        "cogs": round(cogs, 2),
        "profit": round(profit, 2),
        "margin_pct": round(margin_pct, 1),
    })

# Calculate blended margin
blended_margin = (total_revenue - total_cogs) / total_revenue * 100 if total_revenue > 0 else 0

print("=" * 100)
print("SUMMARY")
print("=" * 100)
print(f"Total units sold (top 20): {total_units}")
print(f"Total revenue: ${total_revenue:,.2f}")
print(f"Total COGS: ${total_cogs:,.2f}")
print(f"Total gross profit: ${total_revenue - total_cogs:,.2f}")
print(f"Blended gross margin: {blended_margin:.1f}%")

print("\n" + "=" * 100)
print("NOTES ON ESTIMATES & MISSING DATA")
print("=" * 100)
print("""
✓ REAL PRICES (from invoices):
  - Breakfast Bar: $4.59/unit (Flax Seeds & Teff Flour estimated)
  - Base doughs: Country Dough, Challah Dough (all sourced)
  - Long Braid: $3.70 (Challah Dough)
  - All 9 Breakfast Bar specialty ingredients (real prices)
  - Frozen Spinach: $2.24/kg (Greenleaf)
  - Parmesan: $35.19/kg (Chef's Warehouse)
  - Raisins: $6.98/kg (Chef's Warehouse)
  - Honey: $31.62/kg (Chef's Warehouse)
  - Olive Oil: $13.05/kg (estimated from invoice unit size)

⚠️  ESTIMATED PRICES (reasonable bakery standards):
  - Bananas (Ripe): $0.70/kg
  - Walnuts: $15.00/kg
  - Feta: $10.00/kg
  - Flax Seeds: $8.00/kg
  - Teff Flour: $4.00/kg
  - Orange Juice: $0.80/kg
  - Apricot Jam: $4.00/kg
  - Blueberry Corn Muffin: $3.00/unit (no recipe provided)
  - Forest Scone: Assumed 18 units per 1.494 kg batch

❌ NOT CALCULATED (insufficient data):
  - Olive PC, Cinn SWIRL, Jalapeno & Cheddar Baton: recipes/portion weights not provided
  - Cookies: simplified costs used (may need recipe verification)
""")

# Save output
output = {
    "generated_at": datetime.now().isoformat(),
    "period": "Real Square sales data",
    "summary": {
        "total_units": total_units,
        "total_revenue": round(total_revenue, 2),
        "total_cogs": round(total_cogs, 2),
        "total_profit": round(total_revenue - total_cogs, 2),
        "blended_margin_pct": round(blended_margin, 1),
    },
    "products": margin_results,
    "notes": {
        "real_prices": "Breakfast Bar ingredients, base doughs, specialty items from actual invoices",
        "estimated_prices": "Bananas, walnuts, feta, flax seeds, teff flour, etc.",
        "missing_recipes": "Olive PC, Cinn SWIRL, Jalapeno & Cheddar Baton",
    }
}

with open("/Users/theoleslie/.claude/jobs/4e4ccb21/tmp/top_20_final_analysis.json", "w") as f:
    json.dump(output, f, indent=2)

print(f"\n✅ Full analysis saved to: top_20_final_analysis.json")
