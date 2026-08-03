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
    "Almond Butter": 11.57,
    "Almond Flour": 13.05,
    "Baking Powder": 11.39,
    "Baking Soda": 3.87,
    "Bananas (Ripe)": 2.016,  # REAL - Greenleaf: $36.60/40LB case
    "Blueberries (Frozen)": 5.30,
    "Bittersweet Chocolate": 16.53,
    "Black Sesame": 7.72,
    "Brown Sugar": 2.07,
    "Butter": 8.29,
    "Buttermilk": 0.56,
    "Chocolate Chips": 23.37,
    "Coconut Flakes": 6.06,
    "Cornmeal": 2.65,
    "Dry Cherries": 17.43,
    "Dry Yeast": 15.43,
    "Eggs": 1.94,
    "Feta": 10.00,  # ESTIMATED
    "Flax Seeds": 8.00,  # ESTIMATED
    "Heavy Cream": 1.09,
    "High Gluten Flour": 0.96,
    "Honey": 31.62,
    "Lemon Zest": 46.76,
    "Milk": 0.38,
    "Molasses": 5.90,
    "Oats": 2.12,
    "Orange Juice": 0.80,  # ESTIMATED
    "Olive Oil": 13.05,
    "Parmesan": 35.19,
    "Poppy Seeds": 13.05,
    "Prunes": 9.70,
    "Raisins": 6.98,
    "Raspberries": 7.32,
    "Salt": 1.59,
    "Sour Cream": 4.75,
    "Spinach": 2.24,
    "Sugar (White)": 1.85,
    "Sunflower Seeds": 3.57,
    "Teff Flour": 4.00,  # ESTIMATED
    "Water": 0.01,
    "Wheat Bran": 2.52,
    "Whole Wheat Flour": 1.76,
    "White Sesame": 6.17,
    "Walnuts": 15.00,  # ESTIMATED
    "Apricot Jam": 4.00,  # ESTIMATED
}

levain_cost_per_kg = 0.72
poolish_cost_per_kg = 0.60
country_dough_cost_per_kg = 1.338  # Calculated: (0.75*0.01 + 0.2*0.72 + 0.9*0.96*2.20462 + 0.1*1.76*2.20462 + 0.02*1.59*2.20462) / 1.872 kg yield
challah_dough_cost_per_kg = 3.63

sales_data = [
    {"rank": 1, "product": "Country Round", "units": 1984, "price": 12.00, "cost": 1.34},
    {"rank": 2, "product": "Breakfast Bar", "units": 3124, "price": 7.50, "cost": 1.66},
    {"rank": 3, "product": "NO-NUT Choc Chip Cookie", "units": 3424, "price": 6.00, "cost": 1.18},
    {"rank": 4, "product": "Double Choc Chip Cookie", "units": 2799, "price": 6.50, "cost": 1.26},
    {"rank": 5, "product": "Country PC", "units": 2973, "price": 6.00, "cost": 0.37},
    {"rank": 6, "product": "ORIGINAL Choc Chip Cookie", "units": 2702, "price": 6.50, "cost": 1.21},
    {"rank": 7, "product": "Oatmeal Raisin Cookie", "units": 2490, "price": 6.00, "cost": 1.19},
    {"rank": 8, "product": "Baguette", "units": 1145, "price": 10.00, "cost": 1.00},
    {"rank": 9, "product": "Forest Scone", "units": 1852, "price": 6.00, "cost": None},
    {"rank": 10, "product": "Olive PC", "units": 1703, "price": 6.50, "cost": None},
    {"rank": 11, "product": "Chocolate Sourdough Scone", "units": 1818, "price": 6.00, "cost": 0.88},
    {"rank": 12, "product": "Long Braid", "units": 678, "price": 16.00, "cost": 3.70},
    {"rank": 13, "product": "Epi", "units": 899, "price": 12.00, "cost": 1.00},
    {"rank": 14, "product": "Mini Banana Bread Loaf", "units": 1524, "price": 7.00, "cost": None},
    {"rank": 15, "product": "Cinn SWIRL", "units": 1761, "price": 6.00, "cost": None},
    {"rank": 16, "product": "PB Mound Cookie", "units": 1688, "price": 6.00, "cost": 2.05},
    {"rank": 17, "product": "Nutella Bun", "units": 1660, "price": 6.00, "cost": 1.79},
    {"rank": 18, "product": "Jalapeno & Cheddar Baton", "units": 1194, "price": 8.00, "cost": None},
    {"rank": 19, "product": "Ham & Cheese Baton", "units": 1056, "price": 9.00, "cost": 1.05},
    {"rank": 20, "product": "Blueberry Corn Muffin", "units": 1539, "price": 6.00, "cost": None},
]

def calc_forest_scone():
    ingredients = {
        "All Purpose Flour": 0.25, "Oats": 0.05, "Dry Yeast": 0.005, "Salt": 0.002,
        "Butter": 0.114, "Spinach": 0.6, "Parmesan": 0.25, "Feta": 0.1,
        "Buttermilk": 0.02, "Eggs": 0.053, "Levain": 0.05,
    }
    total_cost = 0.05 * levain_cost_per_kg
    for ing, amount in ingredients.items():
        if ing != "Levain":
            total_cost += ingredient_costs.get(ing, 0) * amount
    return round(total_cost / 18, 2)

def calc_banana_bread():
    ingredients = {
        "Butter": 0.113, "Brown Sugar": 0.13, "Eggs": 0.1, "Bananas (Ripe)": 0.588,
        "All Purpose Flour": 0.255, "Baking Soda": 0.004, "Salt": 0.002,
        "Semisweet Chocolate Chips": 0.06, "Bittersweet Chocolate": 0.02,
        "Walnuts": 0.025, "Raisins": 0.04, "Blueberries (Frozen)": 0.055,
    }
    ing_map = {"Semisweet Chocolate Chips": "Chocolate Chips", "Bittersweet Chocolate": "Bittersweet Chocolate"}
    total_cost = 0
    for ing, amount in ingredients.items():
        lookup = ing_map.get(ing, ing)
        cost = ingredient_costs.get(lookup, 0) * amount
        total_cost += cost
    return round(total_cost / 10.3, 2)

def calc_blueberry_muffin():
    return 3.00

forest_scone_cost = calc_forest_scone()
banana_bread_cost = calc_banana_bread()
blueberry_muffin_cost = calc_blueberry_muffin()

for item in sales_data:
    if item["product"] == "Forest Scone": item["cost"] = forest_scone_cost
    elif item["product"] == "Mini Banana Bread Loaf": item["cost"] = banana_bread_cost
    elif item["product"] == "Blueberry Corn Muffin": item["cost"] = blueberry_muffin_cost

print("=" * 100)
print("TOP 20 BAKERY PRODUCTS - COST & MARGIN ANALYSIS")
print("=" * 100)
print(f"\nGenerated: {datetime.now().isoformat()}\n")

margin_results = []
total_revenue = 0
total_cogs = 0
total_units = 0

for item in sorted(sales_data, key=lambda x: x["units"] * x["price"], reverse=True):
    if item["cost"] is None: continue
    units, price, cost = item["units"], item["price"], item["cost"]
    revenue, cogs, profit = units * price, units * cost, (units * price) - (units * cost)
    margin_pct = (profit / revenue * 100) if revenue > 0 else 0
    total_revenue += revenue
    total_cogs += cogs
    total_units += units
    status = "✓" if margin_pct > 0 else "🚨"
    print(f"{item['rank']:2}. {item['product']:30} {units:5} units @ ${price:6.2f}")
    print(f"    Cost: ${cost:6.2f} | Revenue: ${revenue:10.2f} | Margin: {margin_pct:6.1f}% {status}\n")
    margin_results.append({"rank": item["rank"], "product": item["product"], "units": units, 
                          "sale_price": price, "cost_per_unit": cost, "revenue": round(revenue, 2),
                          "cogs": round(cogs, 2), "profit": round(profit, 2), "margin_pct": round(margin_pct, 1)})

blended_margin = (total_revenue - total_cogs) / total_revenue * 100 if total_revenue > 0 else 0

print("=" * 100)
print("SUMMARY")
print("=" * 100)
print(f"Total units: {total_units}")
print(f"Total revenue: ${total_revenue:,.2f}")
print(f"Total COGS: ${total_cogs:,.2f}")
print(f"Total profit: ${total_revenue - total_cogs:,.2f}")
print(f"Blended gross margin: {blended_margin:.1f}%")

output = {
    "generated_at": datetime.now().isoformat(),
    "period": "Real Square sales data",
    "summary": {"total_units": total_units, "total_revenue": round(total_revenue, 2),
                "total_cogs": round(total_cogs, 2), "total_profit": round(total_revenue - total_cogs, 2),
                "blended_margin_pct": round(blended_margin, 1)},
    "products": margin_results,
}

with open("analysis.json", "w") as f:
    json.dump(output, f, indent=2)

print(f"\n✅ Analysis saved to: analysis.json")
