// Unified token-overlap + Levenshtein matcher for ingredient↔vendor-item and recipe↔Square-item matching.
// Uses the proven algorithm from the prior rebuild: token overlap scoring with prep-descriptor
// exclusion to prevent false matches (e.g. "Blackberries (frozen)" no longer matches "FROZEN EDAMAME").

const STOP = new Set(['for', 'of', 'the', 'and', 'a', 'pinch', 'to', 'with', 'in', 'raw', 'fresh']);

const PREP_DESCRIPTORS = new Set([
  'frozen', 'fresh', 'dried', 'diced', 'chopped', 'sliced', 'minced',
  'ground', 'crushed', 'shredded', 'melted', 'softened', 'cooked', 'whole', 'canned', 'bulk',
  'cold', 'hot', 'warm', 'room', 'temp', 'roasted', 'toasted', 'blanched', 'peeled', 'seeded',
  'stemmed', 'trimmed', 'separated', 'folded',
]);

const englishPart = (n) => String(n).split('/')[0].split('(')[0].trim();

const tokenize = (s) =>
  englishPart(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t && !STOP.has(t));

const candidateTokens = (d) => String(d).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

const getBilingualVariants = (name) => {
  const s = String(name).trim();
  const variants = new Set();

  for (const part of s.split('/')) {
    const match = part.match(/^([^()]+)(?:\(([^)]+)\))?/);
    if (match) {
      if (match[1].trim()) variants.add(match[1].trim());
      if (match[2]?.trim()) variants.add(match[2].trim());
    }
  }
  for (const part of s.split('-')) {
    if (part.trim()) variants.add(part.trim());
  }

  const deduplicated = [];
  const seen = new Set();
  for (const v of variants) {
    const norm = v.toLowerCase();
    if (!seen.has(norm)) {
      deduplicated.push(v);
      seen.add(norm);
    }
  }

  return deduplicated;
};

const editDistance = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
};

const scoreCandidate = (recipeTokens, candidate, fuzzyMatch = false) => {
  const ct = candidateTokens(candidate.description || candidate);
  const cset = new Set(ct);
  let overlap = recipeTokens.filter((t) => cset.has(t));

  if (fuzzyMatch && overlap.length < recipeTokens.length * 0.5) {
    const fuzzyMatched = [];
    for (const rt of recipeTokens) {
      let bestDist = Infinity;
      for (const ct_token of ct) {
        const dist = editDistance(rt, ct_token);
        if (dist < bestDist && dist <= 2) bestDist = dist;
      }
      if (bestDist <= 2) fuzzyMatched.push(rt);
    }
    if (fuzzyMatched.length > overlap.length) overlap = fuzzyMatched;
  }

  if (!overlap.length) return null;
  const head = recipeTokens[recipeTokens.length - 1];
  let score = overlap.length / recipeTokens.length;
  if (ct[0] === head) score += 0.4;
  if (cset.has(head)) score += 0.1;
  score -= ct.length * 0.02;
  if (candidate.pricePerKg != null) score += 0.05;
  return { candidate, score, overlap: overlap.length };
};

const rankCandidates = (ingredientName, candidateList) => {
  const variants = getBilingualVariants(ingredientName);
  const allCandidates = [];

  for (let pass = 0; pass < 2; pass++) {
    const fuzzy = pass === 1;
    for (const variant of variants) {
      const rTok = tokenize(variant);
      if (!rTok.length) continue;

      const allDescriptors = rTok.every((t) => PREP_DESCRIPTORS.has(t));
      if (allDescriptors) continue;

      for (const candidate of candidateList) {
        const scored = scoreCandidate(rTok, candidate, fuzzy);
        if (scored) allCandidates.push(scored);
      }
    }
  }

  return allCandidates.sort((a, b) => b.score - a.score);
};

const confidenceOf = (ranked) => {
  if (!ranked.length) return 'none';
  const top = ranked[0].score;
  const gap = top - (ranked[1]?.score ?? 0);
  if (top >= 1.2 && gap >= 0.25) return 'high';
  if (top >= 0.8) return 'medium';
  return 'low';
};

const findBestMatch = (ingredientName, candidateList) => {
  const ranked = rankCandidates(ingredientName, candidateList);
  if (!ranked.length) return null;
  return {
    match: ranked[0].candidate,
    confidence: confidenceOf(ranked),
    ranked,
  };
};

module.exports = {
  tokenize,
  rankCandidates,
  confidenceOf,
  findBestMatch,
};
