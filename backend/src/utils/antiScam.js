// Anti-scam keyword flagging (spec §8.5). Scans a chat message for the money-
// request / advance-fee patterns common in dating-app scams. A match does NOT
// block or alter the message — the socket layer only sets `Message.flagged =
// true`, which the client uses to keep the standing safety warning visible on the
// thread (per the mockup). Because flagging is non-destructive, the heuristics
// deliberately favour recall over precision: a false positive costs a warning
// banner, a false negative can cost a user their money.

// Phrase patterns. Case-insensitive and whitespace-tolerant (so "giftcard",
// "gift card", and "gift  cards" all trip). Word boundaries keep them from firing
// inside unrelated words.
const KEYWORD_PATTERNS = [
    /\bsend(ing)?\s+(me\s+|us\s+)?(some\s+)?money\b/i,
    /\bgift\s*cards?\b/i,
    /\bwire\s+(transfer|me|the|some|funds?)\b/i,
    /\bbank\s+(transfer|account|details?)\b/i,
    /\baccount\s+(number|details?)\b/i,
    /\b(western\s+union|moneygram)\b/i,
    /\b(bvn|nuban)\b/i,
    /\b(bit\s*coin|crypto(currency)?|usdt|ethereum)\b/i,
    /\btransfer\s+(me\s+)?(some\s+)?(money|cash|funds?)\b/i,
];

// A Nigerian NUBAN bank account is exactly 10 digits. Flag any run of 10+ digits,
// tolerating spaces or hyphens used as groupings ("0123 4567 89"). This can also
// trip on a pasted phone number — acceptable, since flagging never blocks.
function containsAccountNumber(text) {
    const runs = text.match(/\d[\d\s-]*\d/g) || [];
    return runs.some((run) => run.replace(/\D/g, '').length >= 10);
}

// Returns true if the text looks like a money-request scam and should be flagged.
function isScammy(text) {
    if (!text || typeof text !== 'string') return false;
    if (KEYWORD_PATTERNS.some((pattern) => pattern.test(text))) return true;
    return containsAccountNumber(text);
}

module.exports = { isScammy };
