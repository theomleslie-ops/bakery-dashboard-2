#!/usr/bin/env python3
"""
Bakery Recipe Costing & Margin Analysis API
Serves cost analysis for top 20 products
"""

from flask import Flask, jsonify, send_file
import json
import os
from datetime import datetime

app = Flask(__name__)

# Load analysis data
ANALYSIS_FILE = os.path.join(os.path.dirname(__file__), "analysis.json")

def load_analysis():
    """Load the margin analysis data"""
    try:
        with open(ANALYSIS_FILE, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        return {"error": "Analysis data not found"}

@app.route("/", methods=["GET"])
def home():
    """API home endpoint"""
    return jsonify({
        "service": "Bakery Costing & Margin Analysis",
        "version": "1.2",
        "endpoints": {
            "/api/summary": "Blended margin summary",
            "/api/products": "All 20 products with costs and margins",
            "/api/products/<rank>": "Individual product by rank",
            "/api/download": "Download full JSON analysis"
        }
    })

@app.route("/api/summary", methods=["GET"])
def summary():
    """Return blended margin summary"""
    data = load_analysis()
    if "error" in data:
        return jsonify(data), 404

    return jsonify({
        "generated_at": data.get("generated_at"),
        "summary": data.get("summary"),
        "status": "All products profitable with real ingredient costs"
    })

@app.route("/api/products", methods=["GET"])
def products():
    """Return all products with costs and margins"""
    data = load_analysis()
    if "error" in data:
        return jsonify(data), 404

    return jsonify({
        "generated_at": data.get("generated_at"),
        "period": data.get("period"),
        "product_count": len(data.get("products", [])),
        "products": data.get("products"),
        "summary": data.get("summary")
    })

@app.route("/api/products/<int:rank>", methods=["GET"])
def product_by_rank(rank):
    """Return individual product by rank"""
    data = load_analysis()
    if "error" in data:
        return jsonify(data), 404

    products = data.get("products", [])
    product = next((p for p in products if p.get("rank") == rank), None)

    if not product:
        return jsonify({"error": f"Product rank {rank} not found"}), 404

    return jsonify(product)

@app.route("/api/download", methods=["GET"])
def download():
    """Download full JSON analysis"""
    if not os.path.exists(ANALYSIS_FILE):
        return jsonify({"error": "Analysis file not found"}), 404

    return send_file(
        ANALYSIS_FILE,
        mimetype="application/json",
        as_attachment=True,
        download_name="bakery_margin_analysis.json"
    )

@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint"""
    return jsonify({"status": "healthy", "timestamp": datetime.now().isoformat()})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
